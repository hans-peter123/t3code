import { activeSpeechProvider, speechProviderProblem } from "@t3tools/client-runtime/speech";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { AuthOrchestrationOperateScope } from "@t3tools/contracts";

import { VoiceCapture } from "../../native/voiceCapture";
import { readEnvironmentScope } from "../../state/session";
import { currentSpeechSettings } from "../speech/speechSettings";
import { getVoiceTranscriber } from "../speech/speechTranscription";

/** Conversations need the iOS microphone module, so other builds never offer them. */
export const conversationsSupported = VoiceCapture !== null;

export interface ConversationBlocker {
  readonly message: string;
  /** Voice settings can fix it. */
  readonly settings: boolean;
}

/** Why a conversation with this thread cannot start, or null when it can. */
export function conversationBlocker(
  thread: Pick<EnvironmentThreadShell, "environmentId" | "archivedAt" | "deletedAt"> | null,
): ConversationBlocker | null {
  if (!conversationsSupported) {
    return { message: "Conversations need the latest T3 Code for iPhone.", settings: false };
  }
  if (!thread || thread.archivedAt !== null || thread.deletedAt !== null) {
    return { message: "This thread can't receive messages.", settings: false };
  }
  if (!readEnvironmentScope(thread.environmentId, AuthOrchestrationOperateScope)) {
    return { message: "This connection can't send messages to this thread.", settings: false };
  }
  if (!getVoiceTranscriber()) {
    return {
      message: "Set up dictation in Voice settings to talk with the agent.",
      settings: true,
    };
  }
  const provider = activeSpeechProvider(currentSpeechSettings());
  if (!provider || speechProviderProblem(provider)) {
    return { message: "Choose a voice in Voice settings to hear the agent.", settings: true };
  }
  return null;
}
