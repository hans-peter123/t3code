// @effect-diagnostics globalConsole:off - a plain promise API shared by React Native and the web.
import { type EnvironmentId, type MessageId, type ThreadId, WS_METHODS } from "@t3tools/contracts";
import type { Atom, AtomRegistry } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createEnvironmentRpcCommand,
  runAtomCommand,
  squashAtomCommandFailure,
} from "./runtime.ts";

/** The server thread a reply belongs to; drafts have none and are always read in full. */
export interface SpokenSummarySource {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
}

/** Asks environments for the short version of a reply, written from the whole thread. */
export function createSpokenSummaryClient<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
  registry: AtomRegistry.AtomRegistry,
) {
  const command = createEnvironmentRpcCommand(runtime, {
    label: "environment-data:speech:spoken-summary",
    tag: WS_METHODS.speechSpokenSummary,
  });
  // Environments whose last summary failed, so a fallback notice is shown once until one works.
  const failing = new Set<EnvironmentId>();

  return {
    /** Whether this connection may ask the environment for spoken summaries. */
    permissionAtom: command.permissionAtom,
    // The server caches summaries under a key that tracks files and pending requests; a client
    // cache would replay stale ones, so every short read asks it.
    load: async (source: SpokenSummarySource, languageHint?: string): Promise<string> => {
      const hint = languageHint?.trim().slice(0, 35);
      const result = await runAtomCommand(
        registry,
        command,
        {
          environmentId: source.environmentId,
          input: {
            threadId: source.threadId,
            messageId: source.messageId,
            ...(hint ? { languageHint: hint } : {}),
          },
        },
        { reportFailure: false },
      );
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      failing.delete(source.environmentId);
      return result.value.text;
    },
    /** Records a failed summary; true when the user has not been told yet. */
    noteFailure: (environmentId: EnvironmentId, error: unknown): boolean => {
      if (failing.has(environmentId)) return false;
      failing.add(environmentId);
      console.warn("Spoken summary unavailable; reading the full reply.", error);
      return true;
    },
  };
}
