import * as DateTime from "effect/DateTime";
import type {
  MessageId,
  OrchestrationV2ConversationMessage,
  OrchestrationV2RunStatus,
  OrchestrationV2ThreadProjection,
  OrchestrationV2TurnItem,
  RunId,
} from "@t3tools/contracts";
import type {
  SpokenSummaryChangedFile,
  SpokenSummaryContext,
  SpokenSummaryHistoryEntry,
  SpokenSummaryRunOutcome,
} from "@t3tools/provider-core/server/textGeneration";

/** Characters, roughly a quarter of a token each; the latest run gets most of the room. */
const SPOKEN_SUMMARY_BUDGET = {
  originalTask: 6_000,
  history: 28_000,
  userMessage: 2_000,
  earlierReply: 3_000,
  runError: 1_000,
  latestRequest: 6_000,
  latestReply: 60_000,
  changedFiles: 40,
} as const;

export type SpokenSummaryRecords = Pick<
  OrchestrationV2ThreadProjection,
  "thread" | "messages" | "runs" | "checkpoints" | "runtimeRequests" | "turnItems"
>;

export interface SpokenSummaryTarget {
  readonly runId: RunId | null;
  /** The last assistant message spoken about; a later edit of it changes the summary. */
  readonly messageId: MessageId;
  readonly updatedAt: number;
}

const END_CUT = "\n[cut off]";
const START_CUT = "[start cut off]\n";

/** The marker counts toward `max`, so a cut text never exceeds the cap it was cut to. */
export const truncateEnd = (text: string, max: number) =>
  text.length <= max ? text : `${text.slice(0, max - END_CUT.length)}${END_CUT}`;

const truncateStart = (text: string, max: number) =>
  text.length <= max ? text : `${START_CUT}${text.slice(text.length - (max - START_CUT.length))}`;

/** Keeps the newest items that fit, oldest first; older ones are dropped, never interleaved. */
export function selectNewest<T>(
  items: ReadonlyArray<T>,
  budget: number,
  size: (item: T) => number,
): { readonly kept: ReadonlyArray<T>; readonly omitted: number } {
  const kept: T[] = [];
  let remaining = budget;
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index]!;
    if (size(item) > remaining) break;
    kept.unshift(item);
    remaining -= size(item);
  }
  return { kept, omitted: items.length - kept.length };
}

/** Runs that are still working; their interim messages are not a reply to speak about yet. */
const ACTIVE_RUN = new Set<OrchestrationV2RunStatus>([
  "preparing",
  "queued",
  "starting",
  "running",
]);

const isConversation = (message: OrchestrationV2ConversationMessage) =>
  !message.streaming &&
  message.notification === undefined &&
  message.workflowScript !== true &&
  (message.role === "user" || message.role === "assistant") &&
  message.text.trim().length > 0;

function changedFiles(records: SpokenSummaryRecords, runId: RunId | null) {
  const byPath = new Map<string, { additions: number; deletions: number }>();
  if (runId !== null) {
    for (const checkpoint of records.checkpoints) {
      if (checkpoint.runId !== runId) continue;
      for (const file of checkpoint.files) {
        const current = byPath.get(file.path) ?? { additions: 0, deletions: 0 };
        byPath.set(file.path, {
          additions: current.additions + file.additions,
          deletions: current.deletions + file.deletions,
        });
      }
    }
  }
  const files: SpokenSummaryChangedFile[] = [...byPath].map(([path, counts]) => ({
    path,
    ...counts,
  }));
  return {
    files: files.slice(0, SPOKEN_SUMMARY_BUDGET.changedFiles),
    omitted: Math.max(0, files.length - SPOKEN_SUMMARY_BUDGET.changedFiles),
  };
}

function pendingRequests(records: SpokenSummaryRecords): ReadonlyArray<string> {
  const pending = new Set(
    records.runtimeRequests
      .filter((request) => request.status === "pending")
      .map((request) => request.id),
  );
  const described: string[] = [];
  for (const item of records.turnItems) {
    if (item.type === "approval_request" && pending.has(item.requestId)) {
      pending.delete(item.requestId);
      const subject = item.prompt ?? item.reason ?? item.title ?? item.requestKind;
      described.push(`Approval needed: ${truncateEnd(subject, 1_000)}`);
    } else if (item.type === "user_input_request" && pending.has(item.requestId)) {
      pending.delete(item.requestId);
      for (const question of item.questions) {
        const options = question.options.map((option) => option.label).join(", ");
        described.push(
          `Question: ${truncateEnd(question.question, 1_000)}${options ? ` Options: ${options}.` : ""}`,
        );
      }
    }
  }
  return described;
}

function runOutcome(
  records: SpokenSummaryRecords,
  runId: RunId | null,
): SpokenSummaryRunOutcome | null {
  const run = runId === null ? undefined : records.runs.find((candidate) => candidate.id === runId);
  if (run === undefined) return null;
  if (run.status === "rolled_back") return null;
  const status: SpokenSummaryRunOutcome["status"] =
    run.status === "preparing" || run.status === "queued" || run.status === "starting"
      ? "running"
      : run.status;
  const failure =
    status === "failed"
      ? records.turnItems.findLast((item) => item.type === "error" && item.runId === runId)
      : undefined;
  return {
    status,
    error:
      failure?.type === "error"
        ? truncateEnd(failure.failure.message, SPOKEN_SUMMARY_BUDGET.runError)
        : null,
  };
}

/** Same shapes as the client's `getQuestionAnswerText`; picked options are stored by value. */
function answerParts(answer: unknown): ReadonlyArray<string> {
  if (typeof answer === "string") return answer.trim().length > 0 ? [answer.trim()] : [];
  if (Array.isArray(answer)) return answer.flatMap(answerParts);
  if (typeof answer === "object" && answer !== null && "answers" in answer)
    return answerParts(answer.answers);
  return [];
}

/** Questions answered in the question UI; message-mode answers already arrive as user messages. */
function answeredQuestions(item: OrchestrationV2TurnItem): string | null {
  if (item.type !== "user_input_request" || item.responseMode === "message") return null;
  if (item.questionAnswer === undefined) return null;
  const { answers, questionTextById } = item.questionAnswer;
  const lines = Object.entries(answers).flatMap(([questionId, answer]) => {
    const asked = item.questions.find((candidate) => candidate.id === questionId);
    // Some providers use opaque option ids as values; the model should hear what the user picked.
    const labels = answerParts(answer).map(
      (part) =>
        asked?.options.find((option) => (option.value ?? option.label) === part)?.label ?? part,
    );
    if (labels.length === 0) return [];
    const question = questionTextById?.[questionId] ?? asked?.question ?? questionId;
    return [`Answered "${question}": ${labels.join(", ")}`];
  });
  return lines.length === 0 ? null : lines.join("\n");
}

/**
 * Selects what a spoken summary of one run needs from the whole thread. Without a message id it
 * speaks about the latest run that is not still working. Returns null when there is no finished
 * assistant reply to speak about, including when that run ended without one, or the given
 * message is not one.
 */
export function buildSpokenSummaryContext(
  records: SpokenSummaryRecords,
  messageId?: MessageId,
): { readonly context: SpokenSummaryContext; readonly target: SpokenSummaryTarget } | null {
  const liveRuns = records.runs.filter((run) => run.status !== "rolled_back");
  const ordinals = new Map(liveRuns.map((run) => [run.id, run.ordinal]));
  const activeRuns = new Set(
    liveRuns.filter((run) => ACTIVE_RUN.has(run.status)).map((run) => run.id),
  );
  const messages = records.messages.filter(
    (message) => isConversation(message) && (message.runId === null || ordinals.has(message.runId)),
  );
  // A newer run that ended without a reply (failed at once, stopped early) must not fall back to
  // the previous run's reply, which would hide that the latest request did not get one.
  const latestSettled = liveRuns
    .filter((run) => !activeRuns.has(run.id))
    .reduce<(typeof liveRuns)[number] | undefined>(
      (latest, run) => (latest === undefined || run.ordinal > latest.ordinal ? run : latest),
      undefined,
    );
  const anchor =
    messageId !== undefined
      ? messages.find((message) => message.id === messageId && message.role === "assistant")
      : messages.findLast(
          (message) =>
            message.role === "assistant" &&
            (latestSettled === undefined
              ? message.runId === null
              : message.runId === latestSettled.id),
        );
  if (anchor === undefined) return null;

  const runId = anchor.runId;
  const inTarget = (message: OrchestrationV2ConversationMessage) =>
    runId === null ? message.id === anchor.id : message.runId === runId;
  // Imported history has no runs; treat it as older than every run.
  const ordinalOf = (message: OrchestrationV2ConversationMessage) =>
    message.runId === null ? 0 : (ordinals.get(message.runId) ?? 0);
  const targetOrdinal = runId === null ? 0 : (ordinals.get(runId) ?? 0);
  const position = new Map(messages.map((message, index) => [message, index]));
  const anchorPosition = position.get(anchor) ?? 0;
  const earlier = (message: OrchestrationV2ConversationMessage) =>
    !inTarget(message) &&
    (runId === null
      ? (position.get(message) ?? 0) < anchorPosition
      : ordinalOf(message) < targetOrdinal);

  const targetMessages = messages.filter(inTarget);
  const latestAssistant = targetMessages.filter((message) => message.role === "assistant");
  const userMessages = messages.filter((message) => message.role === "user");
  const original = userMessages[0];
  const latestRequest = targetMessages
    .filter((message) => message.role === "user" && message !== original)
    .map((message) => message.text)
    .join("\n\n");

  // Imported history has no runs, so each of its replies stands on its own.
  const replyGroup = (message: OrchestrationV2ConversationMessage) =>
    message.runId ?? `imported:${message.id}`;
  const finalReply = new Map<string, OrchestrationV2ConversationMessage>();
  for (const message of messages) {
    if (message.role === "assistant" && earlier(message))
      finalReply.set(replyGroup(message), message);
  }
  // Within a run: its user messages, then the questions answered during it, then its final reply.
  // Imported history (ordinal 0) keeps its own order.
  const ordered: Array<{
    readonly ordinal: number;
    readonly phase: number;
    readonly entry: SpokenSummaryHistoryEntry;
  }> = [];
  for (const message of messages) {
    if (!earlier(message) || message === original) continue;
    const ordinal = ordinalOf(message);
    if (message.role === "user") {
      ordered.push({
        ordinal,
        phase: 0,
        entry: { role: "user", text: truncateEnd(message.text, SPOKEN_SUMMARY_BUDGET.userMessage) },
      });
    } else if (finalReply.get(replyGroup(message)) === message) {
      // A long reply usually ends with its decision or question.
      ordered.push({
        ordinal,
        phase: ordinal === 0 ? 0 : 2,
        entry: {
          role: "assistant",
          text: truncateStart(message.text, SPOKEN_SUMMARY_BUDGET.earlierReply),
        },
      });
    }
  }
  if (runId !== null) {
    for (const item of records.turnItems) {
      const ordinal = item.runId === null ? undefined : ordinals.get(item.runId);
      if (ordinal === undefined || ordinal >= targetOrdinal) continue;
      const text = answeredQuestions(item);
      if (text === null) continue;
      ordered.push({
        ordinal,
        phase: 1,
        entry: { role: "user", text: truncateEnd(text, SPOKEN_SUMMARY_BUDGET.userMessage) },
      });
    }
  }
  const historyEntries = ordered
    .toSorted((a, b) => a.ordinal - b.ordinal || a.phase - b.phase)
    .map(({ entry }) => entry);
  const history = selectNewest(
    historyEntries,
    SPOKEN_SUMMARY_BUDGET.history,
    (entry) => entry.text.length,
  );
  // The end of a long reply holds its conclusion and open questions.
  const latest = selectNewest(
    latestAssistant.map((message) =>
      truncateStart(message.text, SPOKEN_SUMMARY_BUDGET.latestReply),
    ),
    SPOKEN_SUMMARY_BUDGET.latestReply,
    (text) => text.length,
  );
  const files = changedFiles(records, runId);
  const last = latestAssistant.at(-1) ?? anchor;

  return {
    context: {
      threadTitle: records.thread.title,
      originalTask:
        original === undefined
          ? ""
          : truncateEnd(original.text, SPOKEN_SUMMARY_BUDGET.originalTask),
      history: history.kept,
      omittedHistory: history.omitted,
      latestRequest:
        latestRequest.length === 0
          ? null
          : truncateEnd(latestRequest, SPOKEN_SUMMARY_BUDGET.latestRequest),
      latestReply:
        latest.omitted === 0
          ? latest.kept
          : [`(${latest.omitted} earlier messages of this run left out)`, ...latest.kept],
      latestRunOutcome: runOutcome(records, runId),
      changedFiles: files.files,
      omittedChangedFiles: files.omitted,
      pending: pendingRequests(records),
    },
    target: { runId, messageId: last.id, updatedAt: DateTime.toEpochMillis(last.updatedAt) },
  };
}
