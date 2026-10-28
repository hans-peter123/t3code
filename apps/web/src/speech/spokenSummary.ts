import { useAtomValue } from "@effect/atom-react";
import {
  createEnvironmentRpcCommand,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { type EnvironmentId, type MessageId, type ThreadId, WS_METHODS } from "@t3tools/contracts";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";

/** The server thread a reply belongs to; drafts have none and are always read in full. */
export interface SpokenSummarySource {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
}

const spokenSummaryCommand = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:speech:spoken-summary",
  tag: WS_METHODS.speechSpokenSummary,
});

// Environments whose last summary failed, so a fallback notice is shown once until one works.
const failing = new Set<EnvironmentId>();

/** Whether this connection may ask the environment for spoken summaries. */
export function useCanSummarize(environmentId: EnvironmentId | null): boolean {
  return useAtomValue(spokenSummaryCommand.permissionAtom(environmentId));
}

// The server caches summaries under a key that tracks files and pending requests; a client
// cache would replay stale ones, so every short read asks it.
export async function loadSpokenSummary(source: SpokenSummarySource): Promise<string> {
  const languageHint = navigator.language.slice(0, 35);
  const result = await runAtomCommand(
    appAtomRegistry,
    spokenSummaryCommand,
    {
      environmentId: source.environmentId,
      input: {
        threadId: source.threadId,
        messageId: source.messageId,
        ...(languageHint ? { languageHint } : {}),
      },
    },
    { reportFailure: false },
  );
  if (result._tag === "Failure") throw squashAtomCommandFailure(result);
  failing.delete(source.environmentId);
  return result.value.text;
}

/** Records a failed summary; true when the user has not been told yet. */
export function noteSpokenSummaryFailure(environmentId: EnvironmentId, error: unknown): boolean {
  if (failing.has(environmentId)) return false;
  failing.add(environmentId);
  console.warn("Spoken summary unavailable; reading the full reply.", error);
  return true;
}
