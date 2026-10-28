import { describe, expect, it } from "vite-plus/test";

import { sanitizeSpeechSettings, stepPlaybackRate } from "./settings.ts";

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
