import type { VoiceTranscriber } from "@t3tools/client-runtime/voice-input";

export async function getLocalVoiceTranscriber(
  _resolveLocales?: () => Promise<readonly string[]>,
): Promise<VoiceTranscriber | null> {
  return null;
}
