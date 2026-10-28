import { describe, expect, it } from "vite-plus/test";

import {
  handsFreeSeedThreadFromShell,
  handsFreeThreadEvents,
  handsFreeThreadFromDetail,
  handsFreeThreadFromShell,
  handsFreeWorkingAfterSend,
  NO_THREADS_SEEN,
  type HandsFreeThreadSnapshot,
} from "./handsFreeThreads.ts";

const thread = (patch: Partial<HandsFreeThreadSnapshot> = {}): HandsFreeThreadSnapshot => ({
  environmentId: "e1",
  threadId: "t1",
  title: "Fix login",
  runId: null,
  messageId: null,
  agentWorking: true,
  request: null,
  ...patch,
});

const approvalQ1 = { id: "q1", kind: "approval" } as const;

/** Feeds snapshots in order; returns every event after the first, which only seeds. */
function events(...steps: readonly (readonly HandsFreeThreadSnapshot[])[]) {
  let seen = NO_THREADS_SEEN;
  const all = [];
  for (const threads of steps) {
    const result = handsFreeThreadEvents(seen, threads);
    seen = result.seen;
    all.push(...result.events);
  }
  return all;
}

describe("hands-free thread events", () => {
  it.each<{
    name: string;
    steps: HandsFreeThreadSnapshot[][];
    expected: ReturnType<typeof events>;
  }>([
    {
      name: "the first snapshot only seeds",
      steps: [[thread({ runId: "r1", messageId: "m1", request: approvalQ1 })]],
      expected: [],
    },
    {
      name: "a run finishing is a finished turn",
      steps: [
        [thread()],
        [thread({ runId: "r1", messageId: "m1", agentWorking: false })],
        [thread({ runId: "r1", messageId: "m1", agentWorking: false })],
      ],
      expected: [
        {
          type: "turnFinished",
          environmentId: "e1",
          threadId: "t1",
          title: "Fix login",
          turnId: "r1",
          messageId: "m1",
          agentWorking: false,
        },
      ],
    },
    {
      name: "a newer run under way does not repeat the last finished one",
      steps: [[thread({ runId: "r1" })], [thread()], [thread({ runId: "r1" })]],
      expected: [],
    },
    {
      name: "a new approval is announced once",
      steps: [[thread()], [thread({ request: approvalQ1 })], [thread({ request: approvalQ1 })]],
      expected: [
        {
          type: "inputRequested",
          environmentId: "e1",
          requestId: "q1",
          kind: "approval",
          title: "Fix login",
        },
      ],
    },
    {
      name: "a question the agent asks is announced",
      steps: [[thread()], [thread({ request: { id: "u1", kind: "question" } })]],
      expected: [
        {
          type: "inputRequested",
          environmentId: "e1",
          requestId: "u1",
          kind: "question",
          title: "Fix login",
        },
      ],
    },
    {
      name: "a thread that drops out and returns is not new",
      steps: [[thread({ runId: "r1" })], [], [thread({ runId: "r1" })]],
      expected: [],
    },
    {
      name: "threads with the same id in two environments stay apart",
      steps: [
        [thread(), thread({ environmentId: "e2", runId: "r1" })],
        [thread({ runId: "r1" }), thread({ environmentId: "e2", runId: "r1" })],
      ],
      expected: [
        {
          type: "turnFinished",
          environmentId: "e1",
          threadId: "t1",
          title: "Fix login",
          turnId: "r1",
          messageId: null,
          agentWorking: true,
        },
      ],
    },
  ])("$name", ({ steps, expected }) => {
    expect(events(...steps)).toEqual(expected);
  });
});

describe("seeding the active thread from its list shell", () => {
  const shell = (latestRun: { runId: string; status: string } | null) => ({
    environmentId: "e1",
    id: "t1",
    title: "Fix login",
    latestRun,
    runtime:
      latestRun?.status === "running"
        ? { status: "running", activeRunId: latestRun.runId }
        : { status: "idle", activeRunId: null },
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    source: { pendingRuntimeRequest: null, latestVisibleMessage: null },
  });
  const finished = (runId: string) =>
    expect.objectContaining({ type: "turnFinished", turnId: runId });

  it.each([
    {
      name: "the run under way at the start finishing before the detail loads is told",
      seed: shell({ runId: "r1", status: "running" }),
      detail: thread({ runId: "r1", messageId: "m1", agentWorking: false }),
      expected: [finished("r1")],
    },
    {
      name: "an older run the detail shows first is not told",
      seed: shell({ runId: "r1", status: "running" }),
      detail: thread({ runId: "r0", messageId: "m0" }),
      expected: [],
    },
    {
      name: "a run finished before the start is not told",
      seed: shell({ runId: "r1", status: "completed" }),
      detail: thread({ runId: "r1", messageId: "m1", agentWorking: false }),
      expected: [],
    },
    {
      name: "a first run finishing in a thread without runs is told",
      seed: shell(null),
      detail: thread({ runId: "r1", messageId: "m1", agentWorking: false }),
      expected: [finished("r1")],
    },
  ])("$name", ({ seed, detail, expected }) => {
    const seen = handsFreeSeedThreadFromShell(NO_THREADS_SEEN, seed);
    expect(handsFreeThreadEvents(seen, [detail]).events).toEqual(expected);
  });

  const run = (id: string, ordinal: number, status: string) => ({ id, ordinal, status });

  it.each([
    {
      name: "the awaited run cancelled, then a later run completing is told",
      steps: [
        thread({ runId: "r0", runs: [run("r0", 0, "completed"), run("r1", 1, "running")] }),
        thread({ runId: "r0", runs: [run("r0", 0, "completed"), run("r1", 1, "cancelled")] }),
        thread({
          runId: "r2",
          messageId: "m2",
          agentWorking: false,
          runs: [run("r0", 0, "completed"), run("r1", 1, "cancelled"), run("r2", 2, "completed")],
        }),
      ],
      expected: [finished("r2")],
    },
    {
      name: "a newer run finishing before the awaited one shows finished is told",
      steps: [
        thread({
          runId: "r2",
          messageId: "m2",
          runs: [run("r1", 1, "cancelled"), run("r2", 2, "completed")],
        }),
      ],
      expected: [finished("r2")],
    },
    {
      name: "an older run with the awaited one cancelled is not told",
      steps: [
        thread({ runId: "r0", runs: [run("r0", 0, "completed"), run("r1", 1, "cancelled")] }),
      ],
      expected: [],
    },
  ])("$name", ({ steps, expected }) => {
    let seen = handsFreeSeedThreadFromShell(
      NO_THREADS_SEEN,
      shell({ runId: "r1", status: "running" }),
    );
    const told = [];
    for (const snapshot of steps) {
      const result = handsFreeThreadEvents(seen, [snapshot]);
      seen = result.seen;
      told.push(...result.events);
    }
    expect(told).toEqual(expected);
  });

  it("tells the awaited run after an older one filled in what was seen", () => {
    let seen = handsFreeSeedThreadFromShell(
      NO_THREADS_SEEN,
      shell({ runId: "r1", status: "running" }),
    );
    seen = handsFreeThreadEvents(seen, [thread({ runId: "r0", messageId: "m0" })]).seen;
    const { events } = handsFreeThreadEvents(seen, [
      thread({ runId: "r1", messageId: "m1", agentWorking: false }),
    ]);
    expect(events).toEqual([finished("r1")]);
  });
});

describe("hands-free thread snapshots", () => {
  const detail = {
    environmentId: "e1",
    threadId: "t1",
    title: "Fix login",
    request: null,
  };
  const message = (
    id: string,
    runId: string,
    patch: { streaming?: boolean; text?: string } = {},
  ) => ({
    id,
    runId,
    role: "assistant",
    streaming: false,
    text: "Done.",
    ...patch,
  });

  it("reads the latest finished run from the detail, even with the next one queued", () => {
    expect(
      handsFreeThreadFromDetail({
        ...detail,
        runs: [
          { id: "r1", ordinal: 1, status: "completed" },
          { id: "r2", ordinal: 2, status: "queued" },
        ],
        messages: [message("m1", "r1"), message("m2", "r1", { text: " " })],
      }),
    ).toMatchObject({ runId: "r1", messageId: "m1", agentWorking: true });
  });

  it.each([
    { name: "a stopped run has no reply", status: "interrupted", queueHeld: undefined },
    { name: "a held queue is not work", status: "completed", queueHeld: true },
  ])("$name", ({ status, queueHeld }) => {
    const snapshot = handsFreeThreadFromDetail({
      ...detail,
      runs: [
        { id: "r1", ordinal: 1, status },
        { id: "r2", ordinal: 2, status: "queued", queueHeld },
      ],
      messages: [message("m1", "r1")],
    });
    expect(snapshot.messageId).toBe(status === "completed" ? "m1" : null);
    expect(snapshot.agentWorking).toBe(queueHeld !== true);
  });

  it("does not read a reply still streaming", () => {
    const snapshot = handsFreeThreadFromDetail({
      ...detail,
      runs: [{ id: "r1", ordinal: 1, status: "completed" }],
      messages: [message("m1", "r1", { streaming: true })],
    });
    expect(snapshot.messageId).toBeNull();
  });

  const shell = {
    environmentId: "e1",
    id: "t2",
    title: "Docs",
    latestRun: { runId: "r1", status: "completed" },
    runtime: { status: "idle", activeRunId: null },
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    source: {
      pendingRuntimeRequest: { id: "q1" },
      latestVisibleMessage: { id: "m1", role: "assistant" },
    },
  };

  it.each([
    {
      name: "a finished shell run with an assistant reply",
      input: shell,
      expected: { runId: "r1", messageId: "m1", agentWorking: false, request: null },
    },
    {
      name: "a shell run still running is not known as finished",
      input: {
        ...shell,
        latestRun: { runId: "r2", status: "running" },
        runtime: { status: "running", activeRunId: "r2" },
      },
      expected: { runId: null, messageId: null, agentWorking: true, request: null },
    },
    {
      name: "a shell waiting on approval",
      input: { ...shell, latestRun: { runId: "r1", status: "failed" }, hasPendingApprovals: true },
      expected: { runId: "r1", messageId: null, agentWorking: false, request: approvalQ1 },
    },
    {
      name: "a shell waiting on an answer to a question",
      input: { ...shell, hasPendingUserInput: true },
      expected: { request: { id: "q1", kind: "question" } },
    },
  ])("$name", ({ input, expected }) => {
    expect(handsFreeThreadFromShell(input)).toMatchObject(expected);
  });

  it.each([
    { name: "its run not in the detail yet", runs: [], working: true },
    {
      name: "its run queued",
      runs: [{ id: "r2", ordinal: 2, status: "queued", userMessageId: "d1" }],
      working: true,
    },
    {
      name: "its run already finished",
      runs: [{ id: "r2", ordinal: 2, status: "completed", userMessageId: "d1" }],
      working: false,
    },
    {
      name: "its run finished with another still running",
      runs: [
        { id: "r2", ordinal: 2, status: "completed", userMessageId: "d1" },
        { id: "r3", ordinal: 3, status: "running", userMessageId: "d2" },
      ],
      working: true,
    },
  ])("after a send, the agent works with $name", ({ runs, working }) => {
    expect(handsFreeWorkingAfterSend(runs, "d1")).toBe(working);
  });
});
