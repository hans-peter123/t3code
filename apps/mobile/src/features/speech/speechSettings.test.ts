import { describe, expect, it, vi } from "vite-plus/test";

const store = vi.hoisted(() => new Map<string, string>());

vi.mock("expo-secure-store", () => ({
  getItemAsync: async (key: string) => store.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => void store.set(key, value),
}));

import {
  activeSpeechProvider,
  loadSpeechSettings,
  transcriptionProvider,
  updateSpeechSettings,
} from "./speechSettings";

describe("speechSettings", () => {
  it("returns providers added after the first load", async () => {
    expect((await loadSpeechSettings()).providers).toEqual([]);
    await updateSpeechSettings((current) => ({
      ...current,
      providers: [
        {
          id: "a",
          kind: "openai",
          name: "",
          apiKey: "sk-test",
          baseUrl: "",
          model: "gpt-4o-mini-tts",
          voice: "coral",
          transcriptionModel: "gpt-4o-transcribe",
        },
      ],
      activeProviderId: "a",
    }));
    const settings = await loadSpeechSettings();
    expect(activeSpeechProvider(settings)?.id).toBe("a");
    expect(JSON.parse(store.get("t3code.speech.settings")!).providers).toHaveLength(1);
  });

  it("keeps read aloud off, defaults dictation, and fills models for older entries", async () => {
    await updateSpeechSettings(
      () =>
        ({
          providers: [{ id: "b", kind: "openai-compatible", baseUrl: "https://stt.example/v1" }],
          activeProviderId: null,
          transcriptionProviderId: "b",
          playbackRate: 1,
        }) as never,
    );
    const settings = await loadSpeechSettings();
    expect(settings.activeProviderId).toBeNull();
    expect(transcriptionProvider(settings)?.transcriptionModel).toBe("whisper-1");

    await updateSpeechSettings((current) => ({ ...current, providers: [] }));
    expect((await loadSpeechSettings()).transcriptionProviderId).toBeNull();
  });
});
