import type { VoiceTranscriber } from "@t3tools/client-runtime/voice-input";

export function getLocalVoiceTranscriber(
  _resolveLocales: () => Promise<readonly string[]>,
): VoiceTranscriber | null {
  return null;
}
