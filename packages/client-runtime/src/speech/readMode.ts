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
