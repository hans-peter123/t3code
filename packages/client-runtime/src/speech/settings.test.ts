import { describe, expect, it } from "vite-plus/test";

import {
  createSpeechSettingsStore,
  newSpeechProvider,
  sanitizeSpeechSettings,
  stepPlaybackRate,
  withSpeechProviderAdded,
  withSpeechProviderRemoved,
} from "./settings.ts";

describe("playback rate", () => {
  it("steps by 0.05 so reading can be just a little faster", () => {
    expect(stepPlaybackRate(1, 1)).toBe(1.05);
    expect(stepPlaybackRate(1.05, 1)).toBe(1.1);
    expect(stepPlaybackRate(1, -1)).toBe(0.95);
  });

  it("stops at the supported range", () => {
    expect(stepPlaybackRate(2, 1)).toBe(2);
    expect(stepPlaybackRate(0.75, -1)).toBe(0.75);
  });

  it("keeps saved rates and snaps unknown ones to the nearest step", () => {
    const rate = (playbackRate: unknown) => sanitizeSpeechSettings({ playbackRate }).playbackRate;
    expect(rate(1.25)).toBe(1.25);
    expect(rate(1.07)).toBe(1.05);
    expect(rate(5)).toBe(2);
    expect(rate("fast")).toBe(1);
  });
});

describe("read mode", () => {
  it("defaults to the short version and keeps only known modes", () => {
    const readMode = (value: unknown) => sanitizeSpeechSettings({ readMode: value }).readMode;
    expect(readMode(undefined)).toBe("short");
    expect(readMode("full")).toBe("full");
    expect(readMode("loud")).toBe("short");
  });

  it("reads on double tap unless it was turned off", () => {
    const doubleTap = (value: unknown) =>
      sanitizeSpeechSettings({ doubleTapToRead: value }).doubleTapToRead;
    expect(doubleTap(undefined)).toBe(true);
    expect(doubleTap(false)).toBe(false);
  });
});

describe("dictation language", () => {
  it("follows the thread by default and keeps only locale tags", () => {
    const language = (value: unknown) =>
      sanitizeSpeechSettings({ dictationLanguage: value }).dictationLanguage;
    expect(language(undefined)).toBeNull();
    expect(language("de-DE")).toBe("de-DE");
    expect(language("zh_Hant_TW")).toBe("zh_Hant_TW");
    expect(language("German")).toBeNull();
    expect(language(7)).toBeNull();
  });
});

describe("providers", () => {
  it("keeps a picked voice's name and drops anything that is not text", () => {
    const voiceName = (value: unknown) =>
      sanitizeSpeechSettings({ providers: [{ id: "a", kind: "elevenlabs", voiceName: value }] })
        .providers[0]?.voiceName;
    expect(voiceName("Rachel")).toBe("Rachel");
    expect(voiceName(42)).toBeUndefined();
  });

  it("turns off the jobs of a removed provider instead of moving them to another", () => {
    let settings = sanitizeSpeechSettings({});
    settings = withSpeechProviderAdded(settings, newSpeechProvider("a", "openai"));
    settings = withSpeechProviderAdded(settings, newSpeechProvider("b", "elevenlabs"));
    expect(settings.activeProviderId).toBe("a");
    settings = { ...settings, transcriptionProviderId: "a" };

    const removed = withSpeechProviderRemoved(settings, "a");
    expect(removed.providers.map((provider) => provider.id)).toEqual(["b"]);
    expect(removed.activeProviderId).toBeNull();
    expect(removed.transcriptionProviderId).toBeNull();
    // Stored and read back, the explicit null keeps read aloud off.
    expect(sanitizeSpeechSettings(JSON.parse(JSON.stringify(removed))).activeProviderId).toBeNull();
  });
});

describe("settings store", () => {
  it("never lets a slow earlier write overwrite a newer one", async () => {
    let stored: string | null = null;
    const firstWriteStarted = Promise.withResolvers<() => void>();
    let writes = 0;
    const store = createSpeechSettingsStore({
      read: async () => null,
      write: (value) => {
        writes += 1;
        if (writes > 1) {
          stored = value;
          return Promise.resolve();
        }
        return new Promise<void>((resolve) =>
          firstWriteStarted.resolve(() => {
            stored = value;
            resolve();
          }),
        );
      },
    });
    const first = store.update((current) => ({ ...current, playbackRate: 1.1 }));
    const second = store.update((current) => ({ ...current, playbackRate: 1.5 }));
    const finishFirstWrite = await firstWriteStarted.promise;
    finishFirstWrite();
    await Promise.all([first, second]);
    expect(JSON.parse(stored!).playbackRate).toBe(1.5);
  });
});
