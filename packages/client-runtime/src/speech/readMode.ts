import type { SpeechReadMode } from "./settings.ts";

export interface SpokenText {
  readonly mode: SpeechReadMode;
  readonly text: string;
  /** Why a requested short version fell back to the full reply; clients show a notice. */
  readonly shortUnavailable?: unknown;
}

/**
 * Picks what a reply read aloud plays. Short needs a server thread to summarize; without one it
 * quietly reads the full reply, and a summary that fails or comes back empty falls back too.
 */
export async function resolveSpokenText(input: {
  readonly mode: SpeechReadMode;
  readonly fullText: string;
  readonly loadSummary: (() => Promise<string>) | null;
}): Promise<SpokenText> {
  const full = { mode: "full", text: input.fullText } as const;
  if (input.mode === "full" || !input.loadSummary) return full;
  try {
    const text = (await input.loadSummary()).trim();
    if (text.length > 0) return { mode: "short", text };
    return { ...full, shortUnavailable: new Error("The spoken summary was empty.") };
  } catch (error) {
    return { ...full, shortUnavailable: error };
  }
}

/** The mode a request plays in: Short needs a summary source, so without one it is Full. */
export function requestedReadMode(mode: SpeechReadMode | undefined, canSummarize: boolean) {
  return canSummarize ? (mode ?? "full") : "full";
}

export type SpeakDecision =
  /** Full was asked while a switch to Short is written: keep the full reply, drop the switch. */
  | "cancelShortSwitch"
  /** The same request again while Short is written: nothing to do. */
  | "ignore"
  | "togglePause"
  /** Keep the full reply playing until the short version is ready, so a failure loses nothing. */
  | "switchToShort"
  /** Restart the message in the requested mode. */
  | "start";

/** What a read aloud press does, given what plays now. */
export function decideSpeak(input: {
  /** The message is the one loaded in the player, in any phase but idle. */
  readonly loaded: boolean;
  readonly preparing: boolean;
  readonly switchingToShort: boolean;
  readonly currentMode: SpeechReadMode;
  readonly requestedMode: SpeechReadMode;
}): SpeakDecision {
  if (!input.loaded) return "start";
  if (input.switchingToShort)
    return input.requestedMode === "full" ? "cancelShortSwitch" : "ignore";
  if (input.currentMode === input.requestedMode) return "togglePause";
  if (input.requestedMode === "short" && !input.preparing) return "switchToShort";
  return "start";
}

/** While a switch to Short is written, a toggle already shows the version on its way. */
export function shownSpeechMode(playback: {
  readonly mode: SpeechReadMode;
  readonly writingShort: boolean;
}): SpeechReadMode {
  return playback.writingShort ? "short" : playback.mode;
}
