import type { HandsFreeEvent } from "./handsFree.ts";

/** What the hands-free loop reads from one thread, from its detail or its list shell. */
export interface HandsFreeThreadSnapshot {
  readonly environmentId: string;
  readonly threadId: string;
  readonly title: string;
  /**
   * The latest run that finished, or null when it is not known now: before the first run ends,
   * or while a list shell shows only the newer run under way.
   */
  readonly runId: string | null;
  /** That run's reply; null when it failed, was stopped or ended without one. */
  readonly messageId: string | null;
  /** A turn is running or queued in the thread. */
  readonly agentWorking: boolean;
  /** The approval or question the thread waits on the user for, if any. */
  readonly request: HandsFreeThreadRequest | null;
  /** Every run, from a detail; a list shell knows only its latest. */
  readonly runs?: readonly DetailRun[];
}

export interface HandsFreeThreadRequest {
  readonly id: string;
  readonly kind: "approval" | "question";
}

interface SeenThread {
  readonly runId: string | null;
  readonly requestId: string | null;
  /** Seeded while this run was under way and nothing about it was seen finished yet. */
  readonly awaitingRunId?: string;
}

export type HandsFreeThreadsSeen = ReadonlyMap<string, SeenThread>;

export const NO_THREADS_SEEN: HandsFreeThreadsSeen = new Map();

const threadKey = (thread: HandsFreeThreadSnapshot) =>
  JSON.stringify([thread.environmentId, thread.threadId]);

/**
 * The events a change in the threads means for the loop. A thread's first snapshot only seeds
 * what was seen, so turns finished and approvals asked before the conversation are not told.
 * Threads missing from `threads` keep what was seen, so one that drops out of a list while its
 * environment reconnects is not new when it returns; so does an unknown finished run.
 */
export function handsFreeThreadEvents(
  seen: HandsFreeThreadsSeen,
  threads: readonly HandsFreeThreadSnapshot[],
): { readonly seen: HandsFreeThreadsSeen; readonly events: readonly HandsFreeEvent[] } {
  let next: Map<string, SeenThread> | null = null;
  const events: HandsFreeEvent[] = [];
  for (const thread of threads) {
    const key = threadKey(thread);
    const previous = seen.get(key);
    const awaiting = previous?.awaitingRunId;
    const gate = awaiting === undefined ? "open" : awaitedGate(thread, awaiting);
    const finishedNew =
      previous !== undefined &&
      thread.runId !== null &&
      thread.runId !== previous.runId &&
      gate === "open";
    const current: SeenThread = {
      runId: thread.runId ?? previous?.runId ?? null,
      requestId: thread.request?.id ?? null,
      ...(gate === "closed" && awaiting !== undefined ? { awaitingRunId: awaiting } : {}),
    };
    if (
      previous !== undefined &&
      previous.runId === current.runId &&
      previous.requestId === current.requestId &&
      previous.awaitingRunId === current.awaitingRunId
    ) {
      continue;
    }
    next ??= new Map(seen);
    next.set(key, current);
    if (previous === undefined) continue;
    if (finishedNew && thread.runId !== null) {
      events.push({
        type: "turnFinished",
        environmentId: thread.environmentId,
        threadId: thread.threadId,
        title: thread.title,
        turnId: thread.runId,
        messageId: thread.messageId,
        agentWorking: thread.agentWorking,
      });
    }
    if (thread.request !== null && thread.request.id !== previous.requestId) {
      events.push({
        type: "inputRequested",
        environmentId: thread.environmentId,
        requestId: thread.request.id,
        kind: thread.request.kind,
        title: thread.title,
      });
    }
  }
  return { seen: next ?? seen, events };
}

/**
 * While the run under way at the start is awaited, an older finished run only fills in what was
 * seen ("seed"). Once the awaited run ends in any way, even cancelled, the gate opens for it or a
 * newer one; a detail without it at all only seeds, so the gate never stays shut.
 */
function awaitedGate(
  thread: HandsFreeThreadSnapshot,
  awaiting: string,
): "open" | "closed" | "seed" {
  if (thread.runId === awaiting) return "open";
  if (thread.runs === undefined) return "closed";
  const awaited = thread.runs.find((run) => run.id === awaiting);
  if (awaited === undefined) return "seed";
  if (!SETTLED.has(awaited.status)) return "closed";
  const finished = thread.runs.find((run) => run.id === thread.runId);
  return finished !== undefined && finished.ordinal > awaited.ordinal ? "open" : "seed";
}

/**
 * Seeds a thread from its list shell before its detail loads, so a run under way at the start
 * that finishes before the detail arrives is still told, and an older one is not.
 */
export function handsFreeSeedThreadFromShell(
  seen: HandsFreeThreadsSeen,
  shell: Parameters<typeof handsFreeThreadFromShell>[0],
): HandsFreeThreadsSeen {
  const snapshot = handsFreeThreadFromShell(shell);
  const key = threadKey(snapshot);
  if (seen.has(key)) return seen;
  const run = shell.latestRun;
  const next = new Map(seen);
  next.set(key, {
    runId: snapshot.runId,
    requestId: snapshot.request?.id ?? null,
    ...(run !== null && snapshot.runId === null ? { awaitingRunId: run.runId } : {}),
  });
  return next;
}

const FINISHED = new Set(["completed", "interrupted", "failed"]);
/** Ended without a reply to read: removed from the queue or undone. */
const SETTLED = new Set([...FINISHED, "cancelled", "rolled_back"]);
const WORKING = new Set(["preparing", "starting", "running", "waiting"]);

interface DetailRun {
  readonly id: string;
  readonly ordinal: number;
  readonly status: string;
  readonly userMessageId?: string;
  /** A held queue does not start by itself, so the agent is not working on it. */
  readonly queueHeld?: boolean | undefined;
}

const isWorking = (run: DetailRun) =>
  WORKING.has(run.status) || (run.status === "queued" && run.queueHeld !== true);

/**
 * Whether the agent works on a message just sent, read once the send succeeded and the finished
 * turns the detail shows were delivered: until its run shows finished it is starting or queued.
 * A message that steered a running turn has no run of its own, and that turn still works.
 */
export function handsFreeWorkingAfterSend(runs: readonly DetailRun[], messageId: string): boolean {
  const own = runs.find((run) => run.userMessageId === messageId);
  return own === undefined || !FINISHED.has(own.status) || runs.some(isWorking);
}

/**
 * The active thread from its detail, which knows every run: a turn that finishes while the user's
 * next message already queued behind it is still read.
 */
export function handsFreeThreadFromDetail(input: {
  readonly environmentId: string;
  readonly threadId: string;
  readonly title: string;
  readonly request: HandsFreeThreadRequest | null;
  readonly runs: readonly DetailRun[];
  readonly messages: readonly {
    readonly id: string;
    readonly runId: string | null;
    readonly role: string;
    readonly streaming: boolean;
    readonly text: string;
  }[];
}): HandsFreeThreadSnapshot {
  let finished: (typeof input.runs)[number] | null = null;
  let agentWorking = false;
  for (const run of input.runs) {
    if (FINISHED.has(run.status) && (finished === null || run.ordinal > finished.ordinal)) {
      finished = run;
    }
    if (isWorking(run)) agentWorking = true;
  }
  const reply =
    finished?.status === "completed"
      ? input.messages.findLast(
          (message) =>
            message.role === "assistant" &&
            message.runId === finished.id &&
            !message.streaming &&
            message.text.trim().length > 0,
        )
      : undefined;
  return {
    environmentId: input.environmentId,
    threadId: input.threadId,
    title: input.title,
    runId: finished?.id ?? null,
    messageId: reply?.id ?? null,
    agentWorking,
    request: input.request,
    runs: input.runs,
  };
}

/** Another thread from its list shell, which knows only its latest run. */
export function handsFreeThreadFromShell(shell: {
  readonly environmentId: string;
  readonly id: string;
  readonly title: string;
  readonly latestRun: { readonly runId: string; readonly status: string } | null;
  readonly runtime: { readonly status: string; readonly activeRunId: string | null } | null;
  readonly hasPendingApprovals: boolean;
  readonly hasPendingUserInput: boolean;
  readonly source: {
    readonly pendingRuntimeRequest: { readonly id: string } | null;
    readonly latestVisibleMessage: { readonly id: string; readonly role: string } | null;
  };
}): HandsFreeThreadSnapshot {
  const run = shell.latestRun;
  const finished =
    run !== null && FINISHED.has(run.status) && shell.runtime?.activeRunId !== run.runId
      ? run
      : null;
  const last = shell.source.latestVisibleMessage;
  return {
    environmentId: shell.environmentId,
    threadId: shell.id,
    title: shell.title,
    runId: finished?.runId ?? null,
    messageId: finished?.status === "completed" && last?.role === "assistant" ? last.id : null,
    agentWorking:
      shell.runtime !== null &&
      (WORKING.has(shell.runtime.status) || shell.runtime.status === "queued"),
    request: handsFreeThreadRequest(shell),
  };
}

/** What the thread waits on the user for, from its list shell. */
export function handsFreeThreadRequest(shell: {
  readonly hasPendingApprovals: boolean;
  readonly hasPendingUserInput: boolean;
  readonly source: { readonly pendingRuntimeRequest: { readonly id: string } | null };
}): HandsFreeThreadRequest | null {
  const id = shell.source.pendingRuntimeRequest?.id;
  if (id === undefined) return null;
  if (shell.hasPendingApprovals) return { id, kind: "approval" };
  return shell.hasPendingUserInput ? { id, kind: "question" } : null;
}
