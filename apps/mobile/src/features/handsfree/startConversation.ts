import type { ScopedThreadRef } from "@t3tools/contracts";

import * as Dialog from "../../components/ui/Dialog";
import { rootNavigationRef } from "../../lib/rootNavigation";
import { appAtomRegistry } from "../../state/atom-registry";
import { environmentThreadShells } from "../../state/threads";
import { openSettings } from "../settings/settings-navigation";
import { conversation } from "./conversation";
import { conversationBlocker } from "./conversationAvailability";

export function openConversation(ref: ScopedThreadRef) {
  rootNavigationRef.navigate("ThreadConversation", {
    environmentId: ref.environmentId,
    threadId: ref.threadId,
  });
}

/**
 * Starts talking with a thread from a press, while the app is in the foreground as the microphone
 * needs, and opens the conversation unless it is already in front; explains when it cannot start.
 */
export async function startConversation(ref: ScopedThreadRef, open = true) {
  if (conversation.isRunning(ref)) {
    if (open) openConversation(ref);
    return;
  }
  const blocker = conversationBlocker(
    appAtomRegistry.get(environmentThreadShells.threadShellAtom(ref)),
  );
  if (blocker) {
    if (blocker.settings) {
      Dialog.confirm({
        title: "Can't start a conversation",
        message: blocker.message,
        confirmText: "Open Settings",
        onConfirm: () => openSettings(rootNavigationRef, "SettingsSpeech"),
      });
    } else {
      Dialog.alert("Can't start a conversation", blocker.message);
    }
    return;
  }
  const running = conversation.snapshot();
  if (conversation.isRunning()) {
    // Starting here ends the other one, and anything it was recording, so ask first.
    Dialog.confirm({
      title: "End the other conversation?",
      message: `A conversation with ${running.title} is running. Starting this one ends it.`,
      confirmText: "Start",
      onConfirm: () => void begin(ref, open),
    });
    return;
  }
  await begin(ref, open);
}

async function begin(ref: ScopedThreadRef, open: boolean) {
  try {
    await conversation.start(ref);
  } catch (error) {
    Dialog.alert(
      "Couldn't start the conversation",
      error instanceof Error ? error.message : "Try again.",
    );
    return;
  }
  // A start already under way for another thread may be the one that ran.
  if (open && conversation.isRunning(ref)) openConversation(ref);
}
