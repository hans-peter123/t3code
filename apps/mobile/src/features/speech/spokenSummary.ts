import { useAtomValue } from "@effect/atom-react";
import {
  createSpokenSummaryClient,
  type SpokenSummarySource,
} from "@t3tools/client-runtime/state/spoken-summary";
import type { EnvironmentId } from "@t3tools/contracts";

import { connectionAtomRuntime } from "../../connection/runtime";
import { appAtomRegistry } from "../../state/atom-registry";

const spokenSummary = createSpokenSummaryClient(connectionAtomRuntime, appAtomRegistry);

/** Whether this connection may ask the environment for spoken summaries. */
export function useCanSummarize(environmentId: EnvironmentId | null): boolean {
  return useAtomValue(spokenSummary.permissionAtom(environmentId));
}

/** `useCanSummarize` outside React, read at the moment a reply starts. */
export function canSummarize(environmentId: EnvironmentId): boolean {
  return appAtomRegistry.get(spokenSummary.permissionAtom(environmentId));
}

export const loadSpokenSummary = (source: SpokenSummarySource) =>
  spokenSummary.load(source, Intl.DateTimeFormat().resolvedOptions().locale);

export const noteSpokenSummaryFailure = spokenSummary.noteFailure;
