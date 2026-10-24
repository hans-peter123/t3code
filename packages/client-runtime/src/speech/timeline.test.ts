import { describe, expect, it } from "vite-plus/test";

import {
  locateSpeechTime,
  pcmDuration,
  speechPartStart,
  speechTimelineDuration,
} from "./timeline.ts";

describe("speech timeline", () => {
  it("measures PCM exactly", () => {
    const format = { sampleRate: 24_000, channels: 1 };
    expect(pcmDuration({ format, samples: new Uint8Array(48_000) })).toBe(1);
    expect(
      pcmDuration({ format: { sampleRate: 16_000, channels: 2 }, samples: new Uint8Array(32_000) }),
    ).toBe(0.5);
  });

  const durations = [10, 20, 5];

  it("sums parts and finds where each starts", () => {
    expect(speechTimelineDuration(durations)).toBe(35);
    expect(speechPartStart(durations, 0)).toBe(0);
    expect(speechPartStart(durations, 2)).toBe(30);
  });

  it("maps message positions to a part and offset", () => {
    expect(locateSpeechTime(durations, 0)).toEqual({ index: 0, offset: 0 });
    expect(locateSpeechTime(durations, 9.5)).toEqual({ index: 0, offset: 9.5 });
    expect(locateSpeechTime(durations, 10)).toEqual({ index: 1, offset: 0 });
    expect(locateSpeechTime(durations, 32)).toEqual({ index: 2, offset: 2 });
  });

  it("clamps seeks to the synthesized audio", () => {
    expect(locateSpeechTime(durations, -15)).toEqual({ index: 0, offset: 0 });
    // Past the end waits at the start of the part still being synthesized.
    expect(locateSpeechTime(durations, 35)).toEqual({ index: 3, offset: 0 });
    expect(locateSpeechTime(durations, 50)).toEqual({ index: 3, offset: 0 });
    expect(locateSpeechTime([], 4)).toEqual({ index: 0, offset: 0 });
  });
});
