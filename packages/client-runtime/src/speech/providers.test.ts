import { describe, expect, it } from "vite-plus/test";

import {
  authorizationHeaders,
  listSpeechChoices,
  setSpeechFetch,
  synthesizeSpeech,
} from "./providers.ts";
import { encodeWav } from "./wav.ts";
import { newSpeechProvider } from "./settings.ts";

function answer(status: number, body: unknown, byPath: Record<string, unknown> = {}) {
  const requested: string[] = [];
  setSpeechFetch(async (url) => {
    requested.push(url);
    const path = Object.keys(byPath).find((suffix) => url.endsWith(suffix));
    return path
      ? new Response(JSON.stringify(byPath[path]), { status: 200 })
      : new Response(JSON.stringify(body), { status });
  });
  return requested;
}

describe("listSpeechChoices", () => {
  it("lists only ElevenLabs models that can speak", async () => {
    const requested = answer(200, [
      { model_id: "eleven_multilingual_v2", name: "Multilingual v2", can_do_text_to_speech: true },
      { model_id: "eleven_english_sts_v2", name: "English STS", can_do_text_to_speech: false },
    ]);
    const provider = newSpeechProvider("p", "elevenlabs", { apiKey: "key" });
    await expect(listSpeechChoices(provider, "model")).resolves.toEqual([
      { id: "eleven_multilingual_v2", name: "Multilingual v2" },
    ]);
    expect(requested).toEqual(["https://api.elevenlabs.io/v1/models"]);
  });

  it("reads a custom server's speech models, falling back to /models", async () => {
    const provider = newSpeechProvider("p", "openai-compatible", {
      baseUrl: "http://box:8880/v1/",
    });
    const fallback = answer(404, {}, { "/v1/models": { data: [{ id: "kokoro" }] } });
    await expect(listSpeechChoices(provider, "model")).resolves.toEqual([
      { id: "kokoro", name: "kokoro" },
    ]);
    expect(fallback).toEqual(["http://box:8880/v1/audio/models", "http://box:8880/v1/models"]);

    answer(200, {
      object: "list",
      data: [
        { id: "qwen3-tts-0.6b", task: "text-to-speech" },
        { id: "whisper-large-v3", task: "speech-to-text" },
      ],
    });
    await expect(listSpeechChoices(provider, "transcriptionModel")).resolves.toEqual([
      { id: "whisper-large-v3", name: "whisper-large-v3" },
    ]);
  });

  it("lists a custom server's voices for the chosen model", async () => {
    const voices = answer(200, {
      voices: [
        { id: "aiden", name: "Aiden", models: ["qwen3-tts-0.6b", "tts-1"] },
        { id: "house", models: ["voxcpm2"] },
      ],
    });
    const provider = (model: string) =>
      newSpeechProvider("p", "openai-compatible", { baseUrl: "http://box/v1", model });
    await expect(listSpeechChoices(provider("voxcpm2"), "voice")).resolves.toEqual([
      { id: "house", name: "house" },
    ]);
    expect(voices).toEqual(["http://box/v1/audio/voices"]);
    // An unknown model shows every voice rather than none.
    await expect(listSpeechChoices(provider("other"), "voice")).resolves.toHaveLength(2);

    answer(200, { voices: ["af_bella"] });
    await expect(listSpeechChoices(provider("kokoro"), "voice")).resolves.toEqual([
      { id: "af_bella", name: "af_bella" },
    ]);
  });

  it("puts voices native to the chosen language first and other names last", async () => {
    answer(200, {
      voices: [
        { id: "alloy", is_alias: true, native_language: { code: "de" } },
        { id: "aiden", native_language: { code: "en" } },
        { id: "dylan", description: "German male", native_language: { code: "de" } },
      ],
    });
    const provider = newSpeechProvider("p", "openai-compatible", {
      baseUrl: "http://box/v1",
      language: "de",
    });
    const choices = await listSpeechChoices(provider, "voice");
    expect(choices.map((choice) => choice.id)).toEqual(["dylan", "aiden", "alloy"]);
    expect(choices[0]?.description).toBe("German male");
  });

  it("lists the languages of the chosen model, found by id or alias", async () => {
    answer(200, {
      object: "list",
      data: [
        {
          id: "qwen3-tts-0.6b",
          task: "text-to-speech",
          aliases: ["tts-1-de"],
          languages: [
            { code: "auto", name: "Automatic" },
            { code: "de", name: "German" },
          ],
        },
        { id: "voxcpm2", task: "text-to-speech", languages: [{ code: "auto", name: "Automatic" }] },
      ],
    });
    const provider = (model: string) =>
      newSpeechProvider("p", "openai-compatible", { baseUrl: "http://box/v1", model });
    await expect(listSpeechChoices(provider("tts-1-de"), "language")).resolves.toEqual([
      { id: "auto", name: "Automatic" },
      { id: "de", name: "German" },
    ]);
    await expect(listSpeechChoices(provider("voxcpm2"), "language")).resolves.toHaveLength(1);
  });

  it("asks a custom server for the chosen language, and leaves auto to the model", async () => {
    const bodies: unknown[] = [];
    setSpeechFetch(async (_url, init) => {
      bodies.push(JSON.parse(String(init.body)));
      return new Response(
        encodeWav([
          { format: { sampleRate: 24_000, channels: 1 }, samples: new Uint8Array(4) },
        ]) as Uint8Array<ArrayBuffer>,
      );
    });
    const speak = (language: string) =>
      synthesizeSpeech(
        newSpeechProvider("p", "openai-compatible", { baseUrl: "http://box/v1", language }),
        { text: "Hallo", signal: new AbortController().signal },
      );
    await speak("de");
    await speak("auto");
    expect(bodies.map((body) => (body as { language?: string }).language)).toEqual([
      "de",
      undefined,
    ]);
  });

  it("says so when a custom server has no voice list", async () => {
    answer(404, { detail: "Not Found" });
    const provider = newSpeechProvider("p", "openai-compatible", { baseUrl: "http://box/v1" });
    await expect(listSpeechChoices(provider, "voice")).rejects.toThrow(
      "This server does not list its voices.",
    );
  });

  it("asks OpenAI nothing, since its speech models are known", async () => {
    const requested = answer(500, {});
    const choices = await listSpeechChoices(newSpeechProvider("p", "openai"), "transcriptionModel");
    expect(choices.map((choice) => choice.id)).toContain("gpt-4o-transcribe");
    expect(requested).toEqual([]);
  });
});

describe("authorizationHeaders", () => {
  it("sends a key as Bearer and a user:password login as Basic Auth", () => {
    expect(authorizationHeaders(" nk_key ")).toEqual({ Authorization: "Bearer nk_key" });
    expect(authorizationHeaders("stimme:geheim")).toEqual({
      Authorization: `Basic ${btoa("stimme:geheim")}`,
    });
    expect(authorizationHeaders("  ")).toEqual({});
  });
});
