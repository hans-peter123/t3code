// @effect-diagnostics globalTimers:off - exercises the plain timers the speech module uses.
// @effect-diagnostics globalFetch:off - restores the default speech fetch.
// @effect-diagnostics globalDate:off - builds an HTTP date for Retry-After.
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  parseRetryAfter,
  setSpeechFetch,
  SpeechProviderError,
  transcribeAudio,
} from "./providers.ts";
import type { SpeechProviderConfig } from "./settings.ts";
import {
  planMessageSpeech,
  synthesizeMessageWav,
  synthesizeSpeechParts,
  withSpeechRetry,
} from "./stream.ts";
import { parseWav, type PcmAudio } from "./wav.ts";

const format = { sampleRate: 24_000, channels: 1 };
const provider = {
  id: "test",
  name: "Test",
  kind: "elevenlabs",
  apiKey: "key",
  baseUrl: "",
  model: "eleven_multilingual_v2",
  voice: "voice",
  transcriptionModel: "scribe_v1",
} satisfies SpeechProviderConfig;

function pcm(byte: number): PcmAudio {
  return { format, samples: new Uint8Array([byte, byte]) };
}

function noDelay() {
  const waits: number[] = [];
  return {
    waits,
    delay: async (ms: number) => {
      waits.push(ms);
    },
  };
}

describe("synthesizeSpeechParts", () => {
  it("requests one part at a time, in order, with neighbouring text", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const requests: Array<{
      text: string;
      previousText: string | undefined;
      nextText: string | undefined;
    }> = [];
    const delivered: number[] = [];
    const parts = await synthesizeSpeechParts(provider, ["a", "b", "c"], {
      signal: new AbortController().signal,
      onPart: (_audio, index) => delivered.push(index),
      synthesize: async (_provider, request) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        requests.push({
          text: request.text,
          previousText: request.previousText,
          nextText: request.nextText,
        });
        await Promise.resolve();
        inFlight -= 1;
        return pcm(request.text.charCodeAt(0));
      },
    });
    expect(maxInFlight).toBe(1);
    expect(delivered).toEqual([0, 1, 2]);
    expect(requests).toEqual([
      { text: "a", previousText: undefined, nextText: "b" },
      { text: "b", previousText: "a", nextText: "c" },
      { text: "c", previousText: "b", nextText: undefined },
    ]);
    expect(parts.map((part) => part.samples[0])).toEqual([97, 98, 99]);
  });

  it("stops after an abort without requesting further parts", async () => {
    const controller = new AbortController();
    const requested: string[] = [];
    const run = synthesizeSpeechParts(provider, ["a", "b", "c"], {
      signal: controller.signal,
      onPart: () => controller.abort(),
      synthesize: async (_provider, request) => {
        requested.push(request.text);
        return pcm(1);
      },
    });
    await expect(run).rejects.toThrow();
    expect(requested).toEqual(["a"]);
  });
});

describe("withSpeechRetry", () => {
  it("retries rate limits and server errors with exponential backoff", async () => {
    const { waits, delay } = noDelay();
    let attempts = 0;
    const result = await withSpeechRetry(
      async () => {
        attempts += 1;
        if (attempts === 1) throw new SpeechProviderError("busy", 429);
        if (attempts === 2) throw new SpeechProviderError("oops", 503);
        return "ok";
      },
      new AbortController().signal,
      { delay },
    );
    expect(result).toBe("ok");
    expect(waits).toEqual([1000, 2000]);
  });

  it("honours Retry-After, capped", async () => {
    const { waits, delay } = noDelay();
    let attempts = 0;
    await withSpeechRetry(
      async () => {
        attempts += 1;
        if (attempts === 1) throw new SpeechProviderError("busy", 429, 5000);
        if (attempts === 2) throw new SpeechProviderError("busy", 429, 120_000);
        return "ok";
      },
      new AbortController().signal,
      { delay },
    );
    expect(waits).toEqual([5000, 30_000]);
  });

  it("gives up after three retries", async () => {
    const { waits, delay } = noDelay();
    let attempts = 0;
    const run = withSpeechRetry(
      async () => {
        attempts += 1;
        throw new SpeechProviderError("busy", 429);
      },
      new AbortController().signal,
      { delay },
    );
    await expect(run).rejects.toThrow("busy");
    expect(attempts).toBe(4);
    expect(waits).toEqual([1000, 2000, 4000]);
  });

  it("does not retry client errors", async () => {
    const { waits, delay } = noDelay();
    let attempts = 0;
    const run = withSpeechRetry(
      async () => {
        attempts += 1;
        throw new SpeechProviderError("bad key", 401);
      },
      new AbortController().signal,
      { delay },
    );
    await expect(run).rejects.toThrow("bad key");
    expect(attempts).toBe(1);
    expect(waits).toEqual([]);
  });

  it("waits with a real timer that an abort cancels", async () => {
    const controller = new AbortController();
    const run = withSpeechRetry(async () => {
      throw new SpeechProviderError("busy", 429, 60_000);
    }, controller.signal);
    setTimeout(() => controller.abort(new Error("stopped")), 5);
    await expect(run).rejects.toThrow("stopped");
  });
});

describe("provider requests", () => {
  afterEach(() => setSpeechFetch((url, init) => fetch(url, init)));

  it("reads Retry-After as seconds or a date", () => {
    expect(parseRetryAfter("3")).toBe(3000);
    expect(parseRetryAfter(new Date(10_000).toUTCString(), 4000)).toBe(6000);
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter("soon")).toBeUndefined();
  });

  it("retries ElevenLabs' concurrency 429 and joins the parts sequentially", async () => {
    const { waits, delay } = noDelay();
    const bodies: string[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    let calls = 0;
    setSpeechFetch(async (_url, init) => {
      calls += 1;
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await Promise.resolve();
      inFlight -= 1;
      if (calls === 1) {
        return new Response(
          JSON.stringify({ detail: { message: "Too many concurrent requests" } }),
          { status: 429, headers: { "Retry-After": "2" } },
        );
      }
      bodies.push(JSON.parse(String(init.body)).text);
      return new Response(new Uint8Array([calls, 0, calls, 0]));
    });
    const chunks = planMessageSpeech("One. Two.");
    const parts = await synthesizeSpeechParts(provider, chunks, {
      signal: new AbortController().signal,
      delay,
    });
    expect(waits).toEqual([2000]);
    expect(bodies).toEqual(["One. Two."]);
    expect(maxInFlight).toBe(1);
    expect([...parts[0]!.samples]).toEqual([2, 0, 2, 0]);
  });

  it("reports a provider error with its status", async () => {
    setSpeechFetch(
      async () => new Response(JSON.stringify({ detail: "invalid key" }), { status: 401 }),
    );
    const run = synthesizeMessageWav(provider, "Hello.", new AbortController().signal);
    await expect(run).rejects.toMatchObject({
      status: 401,
      message: "ElevenLabs returned 401: invalid key",
    });
  });

  it("still builds one WAV for the whole message", async () => {
    setSpeechFetch(async () => new Response(new Uint8Array([1, 0])));
    const wav = await synthesizeMessageWav(provider, "Hello.", new AbortController().signal);
    expect([...parseWav(wav).samples]).toEqual([1, 0]);
  });

  it.each([
    ["elevenlabs", "language_code"],
    ["openai", "language"],
  ] as const)("asks %s to transcribe in the dictation language", async (kind, field) => {
    let form: FormData | null = null;
    setSpeechFetch(async (_url, init) => {
      form = init.body as FormData;
      return Response.json({ text: "Hallo" });
    });
    const transcriber = { ...provider, kind, transcriptionModel: "stt" };
    const audio = new Blob([new Uint8Array(4)]);
    const signal = new AbortController().signal;
    expect(await transcribeAudio(transcriber, audio, "a.wav", signal, "de-DE")).toBe("Hallo");
    expect(form!.get(field)).toBe("de");

    await transcribeAudio(transcriber, audio, "a.wav", signal);
    expect(form!.has(field)).toBe(false);

    await transcribeAudio(transcriber, audio, "a.wav", signal, "nb-NO");
    expect(form!.get(field)).toBe("no");
  });

  it("transcribes without the language when the provider rejects it", async () => {
    const sent: (string | null)[] = [];
    setSpeechFetch(async (_url, init) => {
      const language = (init.body as FormData).get("language") as string | null;
      sent.push(language);
      return language
        ? new Response(JSON.stringify({ error: "unsupported language" }), { status: 400 })
        : Response.json({ text: "Hallo" });
    });
    const transcriber = { ...provider, kind: "openai", transcriptionModel: "stt" } as const;
    const audio = new Blob([new Uint8Array(4)]);
    expect(
      await transcribeAudio(transcriber, audio, "a.wav", new AbortController().signal, "yue"),
    ).toBe("Hallo");
    expect(sent).toEqual(["yue", null]);
  });
});
