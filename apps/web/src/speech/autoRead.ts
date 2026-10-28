import type { ChatMessage } from "../types";

export interface AutoReadCursor {
  readonly threadKey: string;
  /** The last run whose reply was read or passed over; undefined until the thread is first seen. */
  readonly runId: string | null | undefined;
}

/**
 * Picks the reply to read once a run settles. A run that had already settled when the thread was
 * first seen is passed over, so opening a thread never reads an old reply.
 */
export function nextAutoRead(
  cursor: AutoReadCursor | null,
  input: {
    readonly threadKey: string;
    readonly runId: string | null;
    readonly settled: boolean;
    readonly messages: readonly ChatMessage[];
  },
): { readonly cursor: AutoReadCursor; readonly reply: ChatMessage | null } {
  const seen =
    cursor?.threadKey === input.threadKey
      ? cursor
      : { threadKey: input.threadKey, runId: undefined };
  if (input.runId === null) return { cursor: seen, reply: null };
  if (seen.runId === undefined) {
    return {
      cursor: { threadKey: input.threadKey, runId: input.settled ? input.runId : null },
      reply: null,
    };
  }
  if (!input.settled || seen.runId === input.runId) return { cursor: seen, reply: null };
  const reply = input.messages.findLast(
    (message) =>
      message.role === "assistant" &&
      message.runId === input.runId &&
      !message.streaming &&
      message.text.trim().length > 0,
  );
  if (!reply) return { cursor: seen, reply: null };
  return { cursor: { threadKey: input.threadKey, runId: input.runId }, reply };
}
