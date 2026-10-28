/** The fields of a thread message the pick reads; web and mobile messages both have them. */
export interface AutoReadMessage {
  readonly role: string;
  readonly runId: string | null;
  readonly streaming: boolean;
  readonly text: string;
}

export interface AutoReadCursor {
  readonly threadKey: string;
  /** The last run whose reply was read or passed over; undefined until the thread is first seen. */
  readonly runId: string | null | undefined;
  /** Device time the snapshot became live. */
  readonly liveSince: number;
  /** The run already under way when the snapshot became live. */
  readonly underway: string | null;
}

/**
 * Picks the reply to read once a run settles. Only a run seen settling while the snapshot is live
 * is read: one already settled on first sight, or settled while not live, is passed over. So is a
 * run already under way on becoming live that settles within `catchUpMs`, for clients whose
 * buffered events arrive after they resume. Stopped runs are never read.
 */
export function nextAutoRead<M extends AutoReadMessage>(
  cursor: AutoReadCursor | null,
  input: {
    readonly threadKey: string;
    readonly runId: string | null;
    readonly settled: boolean;
    /** The settled run finished normally rather than being stopped, failed or rolled back. */
    readonly completed: boolean;
    /** The snapshot is the server's current state and someone is there to hear it. */
    readonly live: boolean;
    /** Device clock only: server timestamps would compare across a possibly skewed clock. */
    readonly now: number;
    readonly catchUpMs: number;
    readonly messages: readonly M[];
  },
): { readonly cursor: AutoReadCursor | null; readonly reply: M | null } {
  if (!input.live) return { cursor: null, reply: null };
  const seen: AutoReadCursor =
    cursor?.threadKey === input.threadKey
      ? cursor
      : {
          threadKey: input.threadKey,
          runId: undefined,
          liveSince: input.now,
          underway: input.settled ? null : input.runId,
        };
  if (input.runId === null) return { cursor: seen, reply: null };
  if (seen.runId === undefined) {
    return { cursor: { ...seen, runId: input.settled ? input.runId : null }, reply: null };
  }
  if (!input.settled || seen.runId === input.runId) return { cursor: seen, reply: null };
  const caughtUp = input.runId === seen.underway && input.now - seen.liveSince < input.catchUpMs;
  if (!input.completed || caughtUp) return { cursor: { ...seen, runId: input.runId }, reply: null };
  const reply = input.messages.findLast(
    (message) =>
      message.role === "assistant" &&
      message.runId === input.runId &&
      !message.streaming &&
      message.text.trim().length > 0,
  );
  if (!reply) return { cursor: seen, reply: null };
  return { cursor: { ...seen, runId: input.runId }, reply };
}
