import * as Dialog from "../components/ui/Dialog";
import { conversationHoldsAudioSession } from "./audioSession";

/** Says why media did not play when a hands-free conversation keeps the audio session. */
export function explainAudioSessionRefusal(action: string): void {
  if (!conversationHoldsAudioSession()) return;
  Dialog.alert("Conversation running", `End the conversation to ${action}.`);
}
