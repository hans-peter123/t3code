import { useAtomValue } from "@effect/atom-react";
import {
  createSpokenSummaryClient,
  type SpokenSummarySource,
} from "@t3tools/client-runtime/state/spoken-summary";
import type { EnvironmentId } from "@t3tools/contracts";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";

const spokenSummary = createSpokenSummaryClient(connectionAtomRuntime, appAtomRegistry);

/** Whether this connection may ask the environment for spoken summaries. */
export function useCanSummarize(environmentId: EnvironmentId | null): boolean {
  return useAtomValue(spokenSummary.permissionAtom(environmentId));
}

export const loadSpokenSummary = (source: SpokenSummarySource) =>
  spokenSummary.load(source, navigator.language);

export const noteSpokenSummaryFailure = spokenSummary.noteFailure;
