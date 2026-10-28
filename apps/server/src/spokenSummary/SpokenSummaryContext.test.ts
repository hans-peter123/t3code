import { describe, expect, it } from "@effect/vitest";
import {
  CheckpointId,
  MessageId,
  type OrchestrationV2Checkpoint,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2Run,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2TurnItem,
  RunId,
  RuntimeRequestId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import {
  buildSpokenSummaryContext,
  selectNewest,
  type SpokenSummaryRecords,
  truncateEnd,
} from "./SpokenSummaryContext.ts";

const threadId = ThreadId.make("thread:spoken");
let clock = 0;
const at = () => DateTime.makeUnsafe(Date.UTC(2026, 9, 1) + ++clock * 1_000);

const message = (
  id: string,
  role: "user" | "assistant",
  text: string,
  run: number | null,
  extra: Partial<OrchestrationV2ConversationMessage> = {},
) =>
  ({
    id: MessageId.make(id),
    threadId,
    runId: run === null ? null : RunId.make(`run:${run}`),
    role,
    text,
    streaming: false,
    attachments: [],
    createdAt: at(),
    updatedAt: at(),
    ...extra,
  }) as OrchestrationV2ConversationMessage;

const run = (ordinal: number, status: OrchestrationV2Run["status"] = "completed") =>
  ({ id: RunId.make(`run:${ordinal}`), ordinal, status }) as OrchestrationV2Run;

const checkpoint = (ordinal: number, files: OrchestrationV2Checkpoint["files"]) =>
  ({
    id: CheckpointId.make(`checkpoint:${ordinal}:${files.length}`),
    runId: RunId.make(`run:${ordinal}`),
    files,
  }) as OrchestrationV2Checkpoint;

const records = (input: Partial<SpokenSummaryRecords>): SpokenSummaryRecords =>
  ({
    thread: { id: threadId, title: "Panel styles" },
    messages: [],
    runs: [],
    checkpoints: [],
    runtimeRequests: [],
    turnItems: [],
    ...input,
  }) as unknown as SpokenSummaryRecords;

describe("buildSpokenSummaryContext", () => {
  it("speaks about the latest run with the whole thread as context", () => {
    const selected = buildSpokenSummaryContext(
      records({
        runs: [run(1), run(2), run(3, "rolled_back"), run(4), run(5, "running")],
        messages: [
          message("u1", "user", "Restyle the thread panel", 1),
          message("a1a", "assistant", "Looking at the panel first.", 1),
          message("a1b", "assistant", "Panel uses a fixed width now.", 1),
          message("u2", "user", "Keep the old colors", 2),
          message("a2", "assistant", "Kept the colors, changed spacing.", 2),
          message("n", "user", "Background task finished", 2, {
            notification: { source: { kind: "system" }, outcome: "completed", summary: "Done" },
          }),
          message("u3", "user", "Try a sidebar instead", 3),
          message("a3", "assistant", "Sidebar version.", 3),
          message("u4", "user", "Now make it responsive", 4),
          message("a4a", "assistant", "Switched to a fluid layout.", 4),
          message("a4b", "assistant", "Should the mobile breakpoint stay at 640?", 4),
          message("a4c", "assistant", "Still typing", 4, { streaming: true }),
          message("u5", "user", "Also check dark mode", 5),
          message("a5", "assistant", "Let me look at the theme first.", 5),
        ],
        checkpoints: [
          checkpoint(4, [{ path: "src/panel.css", kind: "modified", additions: 3, deletions: 1 }]),
          checkpoint(4, [
            { path: "src/panel.css", kind: "modified", additions: 2, deletions: 0 },
            { path: "src/panel.tsx", kind: "modified", additions: 1, deletions: 1 },
          ]),
          checkpoint(2, [{ path: "src/colors.css", kind: "modified", additions: 1, deletions: 1 }]),
        ],
        runtimeRequests: [
          { id: RuntimeRequestId.make("req:open"), status: "pending" },
          { id: RuntimeRequestId.make("req:done"), status: "resolved" },
          { id: RuntimeRequestId.make("req:ask"), status: "pending" },
        ] as unknown as ReadonlyArray<OrchestrationV2RuntimeRequest>,
        turnItems: [
          {
            type: "approval_request",
            requestId: RuntimeRequestId.make("req:open"),
            requestKind: "command",
            prompt: "Run the visual tests",
            title: null,
          },
          {
            type: "approval_request",
            requestId: RuntimeRequestId.make("req:done"),
            requestKind: "command",
            prompt: "Already answered",
            title: null,
          },
          {
            type: "user_input_request",
            runId: RunId.make("run:2"),
            requestId: RuntimeRequestId.make("req:color"),
            questions: [
              {
                id: "q",
                header: "Colors",
                question: "Old or new accent?",
                options: [
                  { label: "Old accent", description: "", value: "opt_old" },
                  { label: "New accent", description: "", value: "opt_new" },
                ],
              },
              {
                id: "where",
                header: "Scope",
                question: "Where?",
                options: [{ label: "Everywhere", description: "" }],
              },
            ],
            questionAnswer: {
              requestId: "req:color",
              questionTextById: { q: "Old or new accent?" },
              answers: { q: ["opt_old"], where: { answers: ["Everywhere", "custom text"] } },
              attachmentsByQuestionId: {},
            },
          },
          {
            type: "user_input_request",
            runId: RunId.make("run:2"),
            requestId: RuntimeRequestId.make("req:by-message"),
            responseMode: "message",
            questions: [{ id: "q", header: "Font", question: "Which font?", options: [] }],
            questionAnswer: {
              requestId: "req:by-message",
              answers: { q: "Inter" },
              attachmentsByQuestionId: {},
            },
          },
          {
            type: "user_input_request",
            requestId: RuntimeRequestId.make("req:ask"),
            questions: [
              {
                id: "q",
                header: "Breakpoint",
                question: "Which breakpoint?",
                options: [
                  { label: "640", description: "Keep" },
                  { label: "768", description: "Wider" },
                ],
              },
            ],
          },
        ] as unknown as ReadonlyArray<OrchestrationV2TurnItem>,
      }),
    );

    expect(selected?.target).toMatchObject({ runId: "run:4", messageId: "a4b" });
    expect(selected?.context).toEqual({
      threadTitle: "Panel styles",
      originalTask: "Restyle the thread panel",
      history: [
        { role: "assistant", text: "Panel uses a fixed width now." },
        { role: "user", text: "Keep the old colors" },
        {
          role: "user",
          text: 'Answered "Old or new accent?": Old accent\nAnswered "Where?": Everywhere, custom text',
        },
        { role: "assistant", text: "Kept the colors, changed spacing." },
      ],
      omittedHistory: 0,
      latestRequest: "Now make it responsive",
      latestReply: ["Switched to a fluid layout.", "Should the mobile breakpoint stay at 640?"],
      latestRunOutcome: { status: "completed", error: null },
      changedFiles: [
        { path: "src/panel.css", additions: 5, deletions: 1 },
        { path: "src/panel.tsx", additions: 1, deletions: 1 },
      ],
      omittedChangedFiles: 0,
      pending: [
        "Approval needed: Run the visual tests",
        "Question: Which breakpoint? Options: 640, 768.",
      ],
    });
  });

  it("speaks about an earlier run without anything that came after it", () => {
    const selected = buildSpokenSummaryContext(
      records({
        runs: [run(1), run(2, "failed"), run(3)],
        turnItems: [
          { type: "error", runId: RunId.make("run:2"), failure: { message: "Old limit" } },
          { type: "error", runId: RunId.make("run:2"), failure: { message: "Rate limited" } },
          { type: "error", runId: RunId.make("run:3"), failure: { message: "Other run" } },
        ] as unknown as ReadonlyArray<OrchestrationV2TurnItem>,
        messages: [
          message("u1", "user", "Fix the login test", 1),
          message("a1", "assistant", "Found a race.", 1),
          message("u2", "user", "Add a retry", 2),
          message("a2", "assistant", "Added the retry.", 2),
          message("u3", "user", "Ship it", 3),
          message("a3", "assistant", "Shipped.", 3),
        ],
      }),
      MessageId.make("a2"),
    );

    expect(selected?.target.runId).toBe("run:2");
    expect(selected?.context).toMatchObject({
      originalTask: "Fix the login test",
      history: [{ role: "assistant", text: "Found a race." }],
      latestRequest: "Add a retry",
      latestReply: ["Added the retry."],
      latestRunOutcome: { status: "failed", error: "Rate limited" },
    });
  });

  it("leaves the latest request out when the run answers the original task", () => {
    const selected = buildSpokenSummaryContext(
      records({
        runs: [run(1)],
        messages: [
          message("u1", "user", "Explain the cache", 1),
          message("a1", "assistant", "It keeps 64 entries.", 1),
        ],
      }),
    );
    expect(selected?.context).toMatchObject({ latestRequest: null, history: [] });
  });

  it("has nothing to speak about without a finished reply", () => {
    const thread = records({
      runs: [run(1), run(2, "running")],
      messages: [
        message("u1", "user", "Hello", 1),
        message("a1", "assistant", "Hi", 1, { streaming: true }),
        message("u2", "user", "Check the tests", 2),
        message("a2", "assistant", "Looking at the tests first.", 2),
      ],
    });
    expect(buildSpokenSummaryContext(thread)).toBeNull();
    expect(buildSpokenSummaryContext(thread, MessageId.make("u1"))).toBeNull();
    // A newer run that failed before replying must not bring back the previous reply.
    const failedWithoutReply = records({
      runs: [run(1), run(2, "failed")],
      messages: [
        message("u1", "user", "Hello", 1),
        message("a1", "assistant", "Hi", 1),
        message("u2", "user", "Now add dark mode", 2),
      ],
    });
    expect(buildSpokenSummaryContext(failedWithoutReply)).toBeNull();
    expect(
      buildSpokenSummaryContext(thread, MessageId.make("a2"))?.context.latestRunOutcome,
    ).toEqual({ status: "running", error: null });
  });

  it("keeps the end of long replies, where the decision and questions are", () => {
    const selected = buildSpokenSummaryContext(
      records({
        runs: [run(1), run(2, "interrupted")],
        messages: [
          message("u1", "user", "Refactor the cache", 1),
          message("a1", "assistant", `${"y".repeat(8_000)}I went with an LRU cache.`, 1),
          message("u2", "user", "Rename it", 2),
          message("a2a", "assistant", "Starting.", 2),
          message("a2b", "assistant", `${"x".repeat(70_000)}Which name do you prefer?`, 2),
        ],
      }),
    );
    const [earlierReply] = selected?.context.history ?? [];
    expect(earlierReply?.text).toHaveLength(3_000);
    expect(earlierReply?.text.endsWith("I went with an LRU cache.")).toBe(true);
    const [note, reply] = selected?.context.latestReply ?? [];
    expect(note).toBe("(1 earlier messages of this run left out)");
    expect(reply).toHaveLength(60_000);
    expect(reply?.endsWith("Which name do you prefer?")).toBe(true);
    expect(selected?.context.latestRunOutcome).toEqual({ status: "interrupted", error: null });
  });
});

describe("selectNewest", () => {
  it("keeps the newest texts that fit within the budget", () => {
    const texts = ["old", "middle", truncateEnd("x".repeat(20), 15)];
    expect(texts[2]).toBe(`xxxxx\n[cut off]`);
    expect(selectNewest(texts, 21, (text) => text.length)).toEqual({
      kept: ["middle", texts[2]],
      omitted: 1,
    });
  });
});
