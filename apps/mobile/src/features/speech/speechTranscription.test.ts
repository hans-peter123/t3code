import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("expo-secure-store", () => ({
  getItemAsync: async () => null,
  setItemAsync: async () => {},
}));
vi.mock("../../native/voiceTranscription", () => ({ getLocalVoiceTranscriber: () => null }));

import type { SpeechProviderConfig } from "./speechSettings";
import { transcribeRecording } from "./speechTranscription";

const server: SpeechProviderConfig = {
  id: "s",
  kind: "openai-compatible",
  name: "GPU",
  apiKey: "secret",
  baseUrl: "https://stt.example/v1/",
  model: "",
  voice: "",
  transcriptionModel: "deepdml/faster-whisper-large-v3-turbo-ct2",
};

// Node's FormData only takes Blobs; React Native also takes its `{ uri, name, type }` file shape.
class FakeFormData {
  private readonly values = new Map<string, unknown>();
  append(key: string, value: unknown) {
    this.values.set(key, value);
  }
  get(key: string) {
    return this.values.get(key);
  }
}

beforeEach(() => vi.stubGlobal("FormData", FakeFormData));
afterEach(() => vi.unstubAllGlobals());

describe("transcribeRecording", () => {
  it("posts the recording to an OpenAI-compatible server", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ text: " Hallo Welt " })));
    vi.stubGlobal("fetch", fetch);
    const text = await transcribeRecording(
      server,
      "file:///tmp/recording-1.m4a",
      new AbortController().signal,
    );
    expect(text).toBe("Hallo Welt");
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://stt.example/v1/audio/transcriptions");
    expect(init.headers).toEqual({ Authorization: "Bearer secret" });
    const form = init.body as unknown as FakeFormData;
    expect(form.get("model")).toBe("deepdml/faster-whisper-large-v3-turbo-ct2");
  });

  it("uses ElevenLabs' speech-to-text endpoint and reports errors", async () => {
    const fetch = vi.fn(
      async () => new Response(JSON.stringify({ detail: { message: "bad key" } }), { status: 401 }),
    );
    vi.stubGlobal("fetch", fetch);
    await expect(
      transcribeRecording(
        { ...server, kind: "elevenlabs", transcriptionModel: "scribe_v1" },
        "file:///tmp/r.m4a",
        new AbortController().signal,
      ),
    ).rejects.toThrow("Transcription at api.elevenlabs.io returned 401: bad key");
    expect((fetch.mock.calls[0] as unknown as [string])[0]).toBe(
      "https://api.elevenlabs.io/v1/speech-to-text",
    );
  });
});
