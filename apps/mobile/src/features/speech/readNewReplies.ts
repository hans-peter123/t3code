import {
  activeSpeechProvider,
  type AutoReadCursor,
  nextAutoRead,
} from "@t3tools/client-runtime/speech";
import { parseThreadKey, threadKey } from "@t3tools/client-runtime/state/entities";
import {
  deriveLatestThreadRun,
  deriveThreadStructureRuntime,
  isLatestRunSettled,
} from "@t3tools/client-runtime/state/thread-execution";
import type { MessageId, ScopedThreadRef } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import * as Dialog from "../../components/ui/Dialog";
import { isAppForeground, subscribeAppState } from "../../lib/appState";
import { audioSessionInUse } from "../../lib/audioSession";
import { environmentThreadDetails } from "../../state/threads";
import { replySpeechRequest } from "./SpeakMessageButton";
import { currentSpeechPhase, speakMessage, SpeechNotConfiguredError } from "./speechPlayback";
import { currentSpeechSettings, updateSpeechSettings, useSpeechSettings } from "./speechSettings";
import { canSummarize } from "./spokenSummary";

/** "Read new replies" on this device, the same setting web keeps. */
export function useReadNewReplies() {
  const settings = useSpeechSettings();
  return {
    /** Read aloud is set up; without a voice the setting would promise nothing. */
    available: activeSpeechProvider(settings) !== null,
    enabled: settings.autoRead,
  };
}

export function setReadNewReplies(autoRead: boolean) {
  void updateSpeechSettings((current) => ({ ...current, autoRead }));
}

function readReply(
  ref: ScopedThreadRef,
  reply: { readonly id: MessageId; readonly text: string },
  title: string,
) {
  if (!activeSpeechProvider(currentSpeechSettings())) return;
  // Passed over while speech plays or dictation or media holds audio; a paused reading is replaced.
  const phase = currentSpeechPhase();
  if (phase === "playing" || phase === "preparing" || (phase === "idle" && audioSessionInUse())) {
    return;
  }
  speakMessage(
    replySpeechRequest({
      messageId: reply.id,
      markdown: reply.text,
      title,
      threadRef: canSummarize(ref.environmentId) ? ref : null,
      mode: undefined,
    }),
  ).catch((error: unknown) => {
    if (error instanceof SpeechNotConfiguredError || !isAppForeground()) return;
    Dialog.alert(
      "Could not read the new reply",
      error instanceof Error ? error.message : "Try again.",
    );
  });
}

// Socket data buffered while iOS suspended the app lands within moments of resuming.
const RESUME_CATCH_UP_MS = 5_000;

const watcherFamily = Atom.family((key: string) => {
  const ref = parseThreadKey(key);
  const structureAtom = environmentThreadDetails.quietThreadAtom(ref);
  const statusAtom = environmentThreadDetails.statusAtom(ref);
  return Atom.make((get) => {
    // Built when reading is turned on or the thread opens, so the first snapshot only seeds it.
    let cursor: AutoReadCursor | null = null;
    // Streamed replies still change `messages` on the quiet structure. The latest run depends
    // on runs, plus sessions and new turn items for a usage-limit stop, so only those re-derive.
    let runKey: readonly [unknown, unknown, number] | null = null;
    let run = { runId: null as string | null, settled: false, completed: false };
    const evaluate = () => {
      const thread = get.registry.get(structureAtom);
      if (thread === null) return;
      const { projection } = thread;
      if (
        runKey === null ||
        runKey[0] !== projection.runs ||
        runKey[1] !== projection.providerSessions ||
        runKey[2] !== projection.turnItems.length
      ) {
        runKey = [projection.runs, projection.providerSessions, projection.turnItems.length];
        const latestRun = deriveLatestThreadRun(projection);
        run = {
          runId: latestRun?.runId ?? null,
          settled: isLatestRunSettled(latestRun, deriveThreadStructureRuntime(projection)),
          completed: latestRun?.status === "completed",
        };
      }
      const next = nextAutoRead(cursor, {
        threadKey: key,
        ...run,
        // Audio cannot start in the background, so a reply settling there is passed over.
        live: get.registry.get(statusAtom) === "live" && isAppForeground(),
        now: Date.now(),
        catchUpMs: RESUME_CATCH_UP_MS,
        messages: projection.messages,
      });
      cursor = next.cursor;
      if (next.reply) readReply(ref, next.reply, projection.thread.title);
    };
    // `subscribe`, not `get`: a rebuild per change would reset the cursor.
    get.subscribe(structureAtom, evaluate);
    get.subscribe(statusAtom, evaluate);
    get.addFinalizer(subscribeAppState(evaluate));
    evaluate();
  }).pipe(Atom.withLabel(`read-new-replies:${key}`));
});

const noWatcher = Atom.make<void>(undefined).pipe(Atom.withLabel("read-new-replies:none"));

/** Mount while the thread is open and reading is on; it reads each reply once its run settles. */
export function readNewRepliesWatcher(ref: ScopedThreadRef | null): Atom.Atom<void> {
  return ref === null ? noWatcher : watcherFamily(threadKey(ref));
}
