import { describe, expect, it, vi } from "vite-plus/test";

const store = vi.hoisted(() => new Map<string, string>());

vi.mock("expo-secure-store", () => ({
  getItemAsync: async (key: string) => store.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => void store.set(key, value),
}));

import { activeSpeechProvider, loadSpeechSettings, updateSpeechSettings } from "./speechSettings";

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
        },
      ],
    }));
    const settings = await loadSpeechSettings();
    expect(activeSpeechProvider(settings)?.id).toBe("a");
    expect(JSON.parse(store.get("t3code.speech.settings")!).providers).toHaveLength(1);
  });
});
