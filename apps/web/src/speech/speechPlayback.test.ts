import { newSpeechProvider, type PcmAudio } from "@t3tools/client-runtime/speech";
import { describe, expect, it, vi } from "vite-plus/test";

const synthesized = vi.hoisted(() => [] as string[]);

vi.mock("@t3tools/client-runtime/speech", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@t3tools/client-runtime/speech")>();
  const piece: PcmAudio = { format: { sampleRate: 8, channels: 1 }, samples: new Uint8Array(16) };
  return {
    ...actual,
    synthesizeSpeechParts: async (
      _provider: unknown,
      chunks: readonly string[],
      options: { onPart?: (audio: PcmAudio, index: number) => void },
    ) => {
      synthesized.push(chunks.join(" "));
      chunks.forEach((_, index) => options.onPart?.(piece, index));
      return chunks.map(() => piece);
    },
  };
});

// The hook's snapshot getter is the store's state; read it outside React.
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot(),
}));
vi.mock("./speechSettings", () => ({ loadSpeechSettings: async () => ({ playbackRate: 1 }) }));

class FakeAudio extends EventTarget {
  static current: FakeAudio | null = null;
  src = "";
  paused = true;
  ended = false;
  currentTime = 0;
  playbackRate = 1;
  defaultPlaybackRate = 1;
  constructor() {
    super();
    FakeAudio.current = this;
  }
  play() {
    this.paused = false;
    this.ended = false;
    this.dispatchEvent(new Event("play"));
    return Promise.resolve();
  }
  pause() {
    this.paused = true;
    this.dispatchEvent(new Event("pause"));
  }
  end() {
    this.paused = true;
    this.ended = true;
    this.dispatchEvent(new Event("ended"));
  }
  removeAttribute() {}
  load() {}
}
vi.stubGlobal("Audio", FakeAudio);

const { currentSpeechPhase, speakMessage, stopSpeech, toggleSpeechPause, useSpeechPlayback } =
  await import("./speechPlayback");

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

describe("speakMessage", () => {
  it("ignores a summary that arrives after the reader switched to the full reply", async () => {
    const summary = deferred<string>();
    const asked = deferred<void>();
    const onShortUnavailable = vi.fn();
    const request = {
      messageId: "m-switch",
      markdown: "Full reply to switch",
      title: "",
      provider,
      loadSummary: () => {
        asked.resolve();
        return summary.promise;
      },
      onShortUnavailable,
    };
    const short = speakMessage({ ...request, mode: "short" });
    await asked.promise;
    expect(useSpeechPlayback("m-switch")).toMatchObject({ phase: "preparing", writingShort: true });
    await speakMessage({ ...request, mode: "full" });
    summary.reject(new Error("late failure"));
    await short;

    expect(onShortUnavailable).not.toHaveBeenCalled();
    expect(useSpeechPlayback("m-switch")).toMatchObject({ mode: "full", phase: "playing" });
    stopSpeech();
  });

  it("reads the full reply once and stops offering Short when the summary fails", async () => {
    const onShortUnavailable = vi.fn();
    await speakMessage({
      messageId: "m-fail",
      markdown: "Full reply after failure",
      title: "",
      mode: "short",
      provider,
      loadSummary: () => Promise.reject(new Error("no provider")),
      onShortUnavailable,
    });

    expect(onShortUnavailable).toHaveBeenCalledTimes(1);
    expect(onShortUnavailable).toHaveBeenCalledWith(expect.any(Error), false);
    expect(synthesized.at(-1)).toContain("Full reply after failure");
    expect(useSpeechPlayback("m-fail")).toMatchObject({ mode: "full", shortAvailable: false });
    stopSpeech();
  });

  it.each([
    { pausedMeanwhile: false, phase: "playing" },
    { pausedMeanwhile: true, phase: "paused" },
  ])(
    "keeps the full reply playing while a switch to Short is written (paused meanwhile: $pausedMeanwhile)",
    async ({ pausedMeanwhile, phase }) => {
      const summary = deferred<string>();
      const request = {
        messageId: "m-to-short",
        markdown: "Full reply playing",
        title: "",
        provider,
        loadSummary: () => summary.promise,
      };
      await speakMessage({ ...request, mode: "full" });
      const switching = speakMessage({ ...request, mode: "short" });

      expect(useSpeechPlayback("m-to-short")).toMatchObject({
        mode: "full",
        phase: "playing",
        writingShort: true,
      });
      if (pausedMeanwhile) toggleSpeechPause();
      summary.resolve("Short version ready");
      await switching;

      expect(synthesized.at(-1)).toBe("Short version ready");
      expect(useSpeechPlayback("m-to-short")).toMatchObject({
        mode: "short",
        phase,
        writingShort: false,
      });
      stopSpeech();
    },
  );

  it("tells the reader and keeps the full reply where it was when a switch to Short fails", async () => {
    const onShortUnavailable = vi.fn();
    const request = {
      messageId: "m-to-short-fail",
      markdown: "Full reply keeps going",
      title: "",
      provider,
      loadSummary: () => Promise.reject(new Error("no provider")),
      onShortUnavailable,
    };
    await speakMessage({ ...request, mode: "full" });
    const runs = synthesized.length;
    await speakMessage({ ...request, mode: "short" });

    expect(synthesized.length).toBe(runs);
    expect(onShortUnavailable).toHaveBeenCalledWith(expect.any(Error), true);
    expect(useSpeechPlayback("m-to-short-fail")).toMatchObject({
      mode: "full",
      phase: "playing",
      shortAvailable: false,
      writingShort: false,
    });
    stopSpeech();
  });

  it("toggles pause for the same message and mode instead of restarting it", async () => {
    const request = { messageId: "m-toggle", markdown: "Toggle me", title: "", provider };
    await speakMessage(request);
    const runs = synthesized.length;
    await speakMessage(request);

    expect(synthesized.length).toBe(runs);
    expect(currentSpeechPhase()).toBe("paused");
    stopSpeech();
  });

  it("offers the full reply when a short version ends, and stopping clears the offer", async () => {
    await speakMessage({
      messageId: "m-end",
      markdown: "Full reply that ends",
      title: "",
      mode: "short",
      provider,
      loadSummary: async () => "Short version",
    });
    FakeAudio.current!.end();

    expect(useSpeechPlayback("m-end")).toMatchObject({ phase: "idle", fullOffer: true });
    stopSpeech();
    expect(useSpeechPlayback("m-end").fullOffer).toBe(false);
  });
});
