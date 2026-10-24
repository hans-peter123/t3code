import type { PcmAudio } from "./wav.ts";

/** Exact length in seconds of 16-bit PCM audio. */
export function pcmDuration(audio: PcmAudio): number {
  return audio.samples.length / (2 * audio.format.channels * audio.format.sampleRate);
}

/** Total length of the parts synthesized so far. */
export function speechTimelineDuration(durations: readonly number[]): number {
  return durations.reduce((total, duration) => total + duration, 0);
}

/** Where part `index` starts on the message timeline. */
export function speechPartStart(durations: readonly number[], index: number): number {
  return speechTimelineDuration(durations.slice(0, index));
}

export interface SpeechTimelinePosition {
  /** The part holding the position; `durations.length` when it lies past the synthesized audio. */
  readonly index: number;
  /** Seconds into that part. */
  readonly offset: number;
}

/**
 * Maps a message position to a part and an offset into it. Positions are clamped to the audio
 * synthesized so far; the end of it maps to the start of the part still to come.
 */
export function locateSpeechTime(
  durations: readonly number[],
  time: number,
): SpeechTimelinePosition {
  let start = 0;
  const target = Math.max(0, time);
  for (let index = 0; index < durations.length; index += 1) {
    const duration = durations[index]!;
    if (target < start + duration) return { index, offset: target - start };
    start += duration;
  }
  return { index: durations.length, offset: 0 };
}
