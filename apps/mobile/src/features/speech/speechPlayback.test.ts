import { newSpeechProvider, type PcmAudio } from "@t3tools/client-runtime/speech";
import type { AudioStatus } from "expo-audio";
import { describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  synthesized: [] as string[],
  // Holds the next synthesis until resolved, or fails it when rejected.
  gate: null as Promise<void> | null,
  onGated: null as (() => void) | null,
  files: new Set<string>(),
  setActive: vi.fn<(active: boolean) => Promise<void>>(async () => {}),
  player: null as FakePlayerShape | null,
}));

interface FakePlayerShape {
  playing: boolean;
  emit(patch?: Partial<AudioStatus>): void;
  /** What a play/pause press on the lock screen or AirPods does. */
  pause(): void;
}

vi.mock("@t3tools/client-runtime/speech", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@t3tools/client-runtime/speech")>();
  // One second of audio per part.
  const piece: PcmAudio = { format: { sampleRate: 8, channels: 1 }, samples: new Uint8Array(16) };
  return {
    ...actual,
    synthesizeSpeechParts: async (
      _provider: unknown,
      chunks: readonly string[],
      options: { onPart?: (audio: PcmAudio, index: number) => void },
    ) => {
      mocks.synthesized.push(chunks.join(" "));
      const gate = mocks.gate;
      mocks.gate = null;
      if (gate) {
        mocks.onGated?.();
        await gate;
      }
      chunks.forEach((_, index) => options.onPart?.(piece, index));
      return chunks.map(() => piece);
    },
  };
});

vi.mock("expo-audio", () => {
  class FakePlayer implements FakePlayerShape {
    playing = false;
    loop = false;
    private listener: ((status: AudioStatus) => void) | null = null;
    constructor() {
      mocks.player = this;
    }
    addListener(_event: string, listener: (status: AudioStatus) => void) {
      this.listener = listener;
    }
    emit(patch: Partial<AudioStatus> = {}) {
      this.listener?.({
        isLoaded: true,
        playing: this.playing,
        currentTime: 0,
        duration: 1,
        didJustFinish: false,
        ...patch,
      } as AudioStatus);
    }
    play() {
      this.playing = true;
      this.emit();
    }
    pause() {
      this.playing = false;
      this.emit();
    }
    replace() {}
    setPlaybackRate() {}
    seekTo() {
      return Promise.resolve();
    }
    setActiveForLockScreen() {}
    clearLockScreenControls() {}
  }
  return {
    AudioModule: {},
    createAudioPlayer: () => new FakePlayer(),
    setAudioModeAsync: async () => {},
    setIsAudioActiveAsync: mocks.setActive,
  };
});

vi.mock("expo-crypto", () => ({
  CryptoDigestAlgorithm: { SHA256: "SHA-256" },
  digestStringAsync: async (_algorithm: string, value: string) =>
    value.replace(/[^a-z0-9]/gi, "").slice(0, 64),
}));

vi.mock("expo-file-system", () => {
  const pathOf = (parent: { uri: string } | string, name: string) =>
    `${typeof parent === "string" ? parent : parent.uri}/${name}`;
  class File {
    readonly uri: string;
    constructor(parent: { uri: string } | string, name: string) {
      this.uri = pathOf(parent, name);
    }
    get exists() {
      return mocks.files.has(this.uri);
    }
    async write() {
      mocks.files.add(this.uri);
    }
    writeSync() {
      mocks.files.add(this.uri);
    }
    delete() {
      mocks.files.delete(this.uri);
    }
  }
  class Directory {
    readonly uri: string;
    constructor(parent: { uri: string } | string, name: string) {
      this.uri = pathOf(parent, name);
    }
    exists = false;
    create() {}
    delete() {}
    list() {
      return [];
    }
  }
  return { Directory, File, Paths: { cache: "cache" } };
});

// The hook's snapshot getter is the store's state; read it outside React.
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot(),
}));
vi.mock("./speechSettings", () => ({
  loadSpeechSettings: async () => ({ playbackRate: 1 }),
  activeSpeechProvider: () => null,
  speechProviderProblem: () => null,
}));

const { speakMessage, stopSpeech, toggleSpeechPause, useSpeechPlayback } =
  await import("./speechPlayback");
const { acquireAudioSession, releaseAudioSession } = await import("../../lib/audioSession");

const provider = newSpeechProvider("p", "openai-compatible", {
  baseUrl: "http://speech.test",
  model: "tts",
});

function deferred<A>() {
  let resolve!: (value: A) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<A>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Plays the single part to its end: it moves to the joined file, seeks, then ends. */
function endAudio() {
  for (let step = 0; step < 3; step += 1) mocks.player!.emit({ didJustFinish: true });
}

function request(messageId: string, loadSummary: () => Promise<string>) {
  return { messageId, markdown: `Full reply ${messageId}`, title: "", provider, loadSummary };
}

describe("speakMessage", () => {
  it("activates the session before the summary is written, and a recording cancels the read", async () => {
    mocks.setActive.mockClear();
    const summary = deferred<string>();
    const asked = deferred<void>();
    const reading = speakMessage({
      ...request("m-early", () => {
        asked.resolve();
        return summary.promise;
      }),
      mode: "short",
    });
    await asked.promise;
    expect(mocks.setActive).toHaveBeenCalledWith(true);
    expect(useSpeechPlayback("m-early")).toMatchObject({ phase: "preparing", writingShort: true });

    const recording = acquireAudioSession("recording");
    expect(useSpeechPlayback("m-early").phase).toBe("idle");
    const runs = mocks.synthesized.length;
    summary.resolve("Too late");
    await reading;
    expect(mocks.synthesized.length).toBe(runs);

    await expect(speakMessage(request("m-busy", () => summary.promise))).rejects.toThrow(
      "Finish dictating to read aloud.",
    );
    expect(useSpeechPlayback("m-busy").phase).toBe("idle");
    await releaseAudioSession(recording);
  });

  it.each([
    { pauseWhile: null, phase: "playing" },
    { pauseWhile: "summary", phase: "paused" },
    { pauseWhile: "synthesis", phase: "paused" },
  ])(
    "switches to Short without releasing the session (paused while: $pauseWhile)",
    async ({ pauseWhile, phase }) => {
      const summary = deferred<string>();
      const synthesis = deferred<void>();
      const input = request("m-switch", () => summary.promise);
      await speakMessage({ ...input, mode: "full" });
      mocks.setActive.mockClear();
      mocks.gate = synthesis.promise;
      const gated = deferred<void>();
      mocks.onGated = gated.resolve;
      const switching = speakMessage({ ...input, mode: "short" });
      expect(useSpeechPlayback("m-switch")).toMatchObject({ mode: "full", writingShort: true });
      if (pauseWhile === "summary") toggleSpeechPause();
      // Distinct per row, so no cached short version skips synthesis.
      summary.resolve(`Short version ready ${pauseWhile}`);
      await gated.promise;
      // The full reply keeps the player until the first short part is ready.
      expect(useSpeechPlayback("m-switch")).toMatchObject({ mode: "full", writingShort: true });
      if (pauseWhile === "synthesis") mocks.player!.pause();
      synthesis.resolve();
      await switching;

      expect(useSpeechPlayback("m-switch")).toMatchObject({ mode: "short", phase });
      expect(mocks.setActive).not.toHaveBeenCalledWith(false);
      stopSpeech();
    },
  );

  it("keeps the full reply playing when the short version cannot be read", async () => {
    const synthesis = deferred<void>();
    const input = {
      ...request("m-switch-fail", () => Promise.resolve("Short that fails")),
      onShortUnavailable: () => true,
    };
    await speakMessage({ ...input, mode: "full" });
    mocks.gate = synthesis.promise;
    const switching = speakMessage({ ...input, mode: "short" });
    synthesis.reject(new Error("speech provider down"));
    await switching;
    expect(useSpeechPlayback("m-switch-fail")).toMatchObject({
      mode: "full",
      phase: "playing",
      writingShort: false,
      shortAvailable: false,
      shortUnavailable: true,
    });
    stopSpeech();
  });

  it.each([
    { pausedOnLockScreen: false, phase: "playing" },
    { pausedOnLockScreen: true, phase: "paused" },
  ])(
    "plays the chosen short version when the full reply ends while it is written (paused on the lock screen: $pausedOnLockScreen)",
    async ({ pausedOnLockScreen, phase }) => {
      // Cached silence starts playing at once.
      mocks.files.add("cache/speech/silence.wav");
      const summary = deferred<string>();
      const input = request("m-ends", () => summary.promise);
      await speakMessage({ ...input, mode: "full" });
      const switching = speakMessage({ ...input, mode: "short" });
      endAudio();
      expect(useSpeechPlayback("m-ends")).toMatchObject({ phase: "preparing", writingShort: true });
      expect(mocks.player!.playing).toBe(true);
      if (pausedOnLockScreen) mocks.player!.pause();

      summary.resolve("Short after the end");
      await switching;
      expect(mocks.synthesized.at(-1)).toBe("Short after the end");
      expect(useSpeechPlayback("m-ends")).toMatchObject({ mode: "short", phase });

      endAudio();
      expect(useSpeechPlayback("m-ends")).toMatchObject({ phase: "idle", fullOffer: true });
      stopSpeech();
      expect(useSpeechPlayback("m-ends").fullOffer).toBe(false);
    },
  );

  it("tells the reader when the short version fails after the full reply ended", async () => {
    const summary = deferred<string>();
    const loadSummary = vi.fn(() => summary.promise);
    const onShortUnavailable = vi.fn(() => true);
    const input = { ...request("m-ends-fail", loadSummary), onShortUnavailable };
    await speakMessage({ ...input, mode: "full" });
    const switching = speakMessage({ ...input, mode: "short" });
    endAudio();
    summary.reject(new Error("no summary"));
    await switching;
    // Nothing reads the full reply, so the reader is not told it does.
    expect(onShortUnavailable).toHaveBeenCalledWith(expect.any(Error), true, false);
    expect(useSpeechPlayback("m-ends-fail")).toMatchObject({
      phase: "idle",
      shortUnavailable: true,
    });

    // The next press reads the full reply rather than waiting on the same failing summary.
    await speakMessage({ ...input, mode: "short" });
    expect(loadSummary).toHaveBeenCalledTimes(1);
    expect(mocks.synthesized.at(-1)).toContain("Full reply m-ends-fail");
    expect(useSpeechPlayback("m-ends-fail")).toMatchObject({
      mode: "full",
      shortAvailable: false,
      shortUnavailable: false,
    });
    stopSpeech();
  });

  it("reads the full reply and stops offering Short when the summary fails", async () => {
    const onShortUnavailable = vi.fn(() => false);
    await speakMessage({
      ...request("m-fail", () => Promise.reject(new Error("no provider"))),
      mode: "short",
      onShortUnavailable,
    });
    expect(onShortUnavailable).toHaveBeenCalledWith(expect.any(Error), false, true);
    expect(mocks.synthesized.at(-1)).toContain("Full reply m-fail");
    expect(useSpeechPlayback("m-fail")).toMatchObject({ mode: "full", shortAvailable: false });
    stopSpeech();
  });
});
