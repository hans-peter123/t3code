import { describe, expect, it } from "vite-plus/test";

import {
  HANDS_FREE_COPY,
  HANDS_FREE_OFF,
  handsFreeReducer,
  type HandsFreeEffect,
  type HandsFreeEvent,
  type HandsFreeState,
} from "./handsFree.ts";

const start: HandsFreeEvent = {
  type: "start",
  environmentId: "e1",
  threadId: "t1",
  readMode: "short",
  agentWorking: false,
};
const working: HandsFreeEvent = { ...start, agentWorking: true };
const reply = (messageId: string | null, agentWorking = false, turnId = `turn-${messageId}`) =>
  ({
    type: "turnFinished",
    environmentId: "e1",
    threadId: "t1",
    title: "Fix login",
    turnId,
    messageId,
    agentWorking,
  }) satisfies HandsFreeEvent;
const otherDone: HandsFreeEvent = {
  type: "turnFinished",
  environmentId: "e1",
  threadId: "t2",
  title: "Docs",
  turnId: "x",
  messageId: "x",
  agentWorking: false,
};
const approval: HandsFreeEvent = {
  type: "approvalRequested",
  environmentId: "e1",
  requestId: "r1",
  title: "Docs",
};

/** Folds events from off; returns the final state and the effects of the last event. */
function run(events: readonly HandsFreeEvent[], from: HandsFreeState = HANDS_FREE_OFF) {
  let state = from;
  let effects: readonly HandsFreeEffect[] = [];
  for (const event of events) {
    ({ state, effects } = handsFreeReducer(state, event));
  }
  return { state, effects };
}

// Ids are the reducer's counter: tone 1 doubles as recording 1, the send is 2.
const listening: HandsFreeEvent[] = [start, { type: "toneEnded", id: 1 }];
const sending: HandsFreeEvent[] = [
  ...listening,
  { type: "done" },
  { type: "transcribed", id: 1, text: "Add a test", draftId: "d1" },
];
const speakingReply: HandsFreeEvent[] = [working, reply("m1")];
const unsent: HandsFreeEvent[] = [
  ...sending,
  { type: "sendFailed", id: 2 },
  { type: "speechEnded", id: 3 },
];

describe("hands-free loop", () => {
  it.each<{
    name: string;
    events: HandsFreeEvent[];
    phase: string;
    effects: HandsFreeEffect[];
  }>([
    {
      name: "start while idle plays the tone",
      events: [start],
      phase: "tone",
      effects: [{ type: "playTone", id: 1 }],
    },
    { name: "start while the agent works waits", events: [working], phase: "waiting", effects: [] },
    {
      name: "the tone ending starts recording",
      events: listening,
      phase: "listening",
      effects: [{ type: "startRecording", id: 1 }],
    },
    {
      name: "Done transcribes",
      events: [...listening, { type: "done" }],
      phase: "transcribing",
      effects: [{ type: "finishRecording", id: 1 }],
    },
    {
      name: "Done pressed twice transcribes once",
      events: [...listening, { type: "done" }, { type: "done" }],
      phase: "transcribing",
      effects: [],
    },
    {
      name: "a transcript is sent",
      events: sending,
      phase: "sending",
      effects: [
        {
          type: "send",
          id: 2,
          draftId: "d1",
          environmentId: "e1",
          threadId: "t1",
          text: "Add a test",
        },
      ],
    },
    {
      name: "a sent message waits for the agent",
      events: [...sending, { type: "sent", id: 2, agentWorking: true }],
      phase: "waiting",
      effects: [],
    },
    {
      name: "a reply in the thread is read in the read mode",
      events: speakingReply,
      phase: "speaking",
      effects: [
        {
          type: "speakReply",
          id: 1,
          environmentId: "e1",
          threadId: "t1",
          messageId: "m1",
          mode: "short",
        },
      ],
    },
    {
      name: "a reply read to the end leads to listening",
      events: [...speakingReply, { type: "speechEnded", id: 1 }],
      phase: "tone",
      effects: [{ type: "playTone", id: 2 }],
    },
    {
      name: "talk while reading skips to listening",
      events: [...speakingReply, { type: "talk" }],
      phase: "tone",
      effects: [{ type: "stopAudio" }, { type: "playTone", id: 2 }],
    },
    {
      name: "talk while waiting starts listening",
      events: [working, { type: "talk" }],
      phase: "tone",
      effects: [{ type: "playTone", id: 1 }],
    },
    {
      name: "a failed short version falls back to the full reply",
      events: [...speakingReply, { type: "speechFailed", id: 1 }],
      phase: "speaking",
      effects: [
        { type: "notify", message: HANDS_FREE_COPY.shortUnavailable },
        {
          type: "speakReply",
          id: 2,
          environmentId: "e1",
          threadId: "t1",
          messageId: "m1",
          mode: "full",
        },
      ],
    },
    {
      name: "a failed full reply moves on to listening",
      events: [...speakingReply, { type: "speechFailed", id: 1 }, { type: "speechFailed", id: 2 }],
      phase: "tone",
      effects: [
        { type: "notify", message: HANDS_FREE_COPY.replyUnavailable },
        { type: "playTone", id: 3 },
      ],
    },
    {
      name: "an empty transcript is not sent",
      events: [
        ...listening,
        { type: "done" },
        { type: "transcribed", id: 1, text: "  ", draftId: "d1" },
      ],
      phase: "speaking",
      effects: [{ type: "speak", id: 2, text: HANDS_FREE_COPY.nothingHeard }],
    },
    {
      name: "after saying nothing was heard it listens again",
      events: [
        ...listening,
        { type: "done" },
        { type: "transcribed", id: 1, text: "", draftId: "d1" },
        { type: "speechEnded", id: 2 },
      ],
      phase: "tone",
      effects: [{ type: "playTone", id: 3 }],
    },
    {
      name: "a failed transcription says so",
      events: [...listening, { type: "done" }, { type: "transcriptionFailed", id: 1 }],
      phase: "speaking",
      effects: [{ type: "speak", id: 2, text: HANDS_FREE_COPY.transcriptionFailed }],
    },
    {
      name: "a failed send says so",
      events: [...sending, { type: "sendFailed", id: 2 }],
      phase: "speaking",
      effects: [{ type: "speak", id: 3, text: HANDS_FREE_COPY.sendFailed }],
    },
    { name: "a failed send holds the message", events: unsent, phase: "unsent", effects: [] },
    {
      name: "Done after a failed send resends the same draft",
      events: [...unsent, { type: "done" }],
      phase: "sending",
      effects: [
        {
          type: "send",
          id: 4,
          draftId: "d1",
          environmentId: "e1",
          threadId: "t1",
          text: "Add a test",
        },
      ],
    },
    {
      name: "Done during the failed send notice resends at once",
      events: [...sending, { type: "sendFailed", id: 2 }, { type: "done" }],
      phase: "sending",
      effects: [
        { type: "stopAudio" },
        {
          type: "send",
          id: 4,
          draftId: "d1",
          environmentId: "e1",
          threadId: "t1",
          text: "Add a test",
        },
      ],
    },
    {
      name: "talk after a failed send resends it",
      events: [...unsent, { type: "talk" }],
      phase: "sending",
      effects: [
        {
          type: "send",
          id: 4,
          draftId: "d1",
          environmentId: "e1",
          threadId: "t1",
          text: "Add a test",
        },
      ],
    },
    {
      name: "talk during the failed send notice resends at once",
      events: [...sending, { type: "sendFailed", id: 2 }, { type: "talk" }],
      phase: "sending",
      effects: [
        { type: "stopAudio" },
        {
          type: "send",
          id: 4,
          draftId: "d1",
          environmentId: "e1",
          threadId: "t1",
          text: "Add a test",
        },
      ],
    },
    {
      name: "re-record after a failed send records a new message",
      events: [...unsent, { type: "rerecord" }],
      phase: "tone",
      effects: [{ type: "playTone", id: 4 }],
    },
    {
      name: "a new recording after a failed send is a new draft",
      events: [
        ...unsent,
        { type: "rerecord" },
        { type: "toneEnded", id: 4 },
        { type: "done" },
        { type: "transcribed", id: 4, text: "Add two tests", draftId: "d2" },
      ],
      phase: "sending",
      effects: [
        {
          type: "send",
          id: 5,
          draftId: "d2",
          environmentId: "e1",
          threadId: "t1",
          text: "Add two tests",
        },
      ],
    },
    {
      name: "an approval while a failed send is held is announced",
      events: [...unsent, approval],
      phase: "speaking",
      effects: [{ type: "speak", id: 4, text: "Docs needs approval" }],
    },
    {
      name: "discard after a failed send drops it and waits",
      events: [...unsent, { type: "discard" }],
      phase: "waiting",
      effects: [],
    },
    {
      name: "a microphone failure says so and waits",
      events: [...listening, { type: "recordingFailed", id: 1 }, { type: "speechEnded", id: 2 }],
      phase: "waiting",
      effects: [],
    },
    {
      name: "a notice that can't be spoken is shown instead",
      events: [...listening, { type: "recordingFailed", id: 1 }, { type: "speechFailed", id: 2 }],
      phase: "waiting",
      effects: [{ type: "notify", message: HANDS_FREE_COPY.recordingFailed }],
    },
    {
      name: "a turn without a reply while waiting says so",
      events: [working, reply(null)],
      phase: "speaking",
      effects: [{ type: "speak", id: 1, text: HANDS_FREE_COPY.noReply }],
    },
    {
      name: "after a turn without a reply it listens",
      events: [working, reply(null), { type: "speechEnded", id: 1 }],
      phase: "tone",
      effects: [{ type: "playTone", id: 2 }],
    },
    {
      name: "a turn without a reply while a newer one runs stays quiet",
      events: [working, reply(null, true)],
      phase: "waiting",
      effects: [],
    },
    {
      name: "another thread stopping without a reply is announced",
      events: [working, { ...otherDone, messageId: null }],
      phase: "speaking",
      effects: [{ type: "speak", id: 1, text: HANDS_FREE_COPY.threadStopped("Docs") }],
    },
    {
      name: "a send abandoned by stop that fails is shown with its text",
      events: [...sending, { type: "stop" }, { type: "sendFailed", id: 2 }],
      phase: "off",
      effects: [{ type: "notify", message: HANDS_FREE_COPY.abandonedSendFailed("Add a test") }],
    },
    {
      name: "discard drops the recording and waits",
      events: [...listening, { type: "discard" }],
      phase: "waiting",
      effects: [{ type: "cancelRecording" }],
    },
    {
      name: "re-record drops the recording and listens again",
      events: [...listening, { type: "rerecord" }],
      phase: "tone",
      effects: [{ type: "cancelRecording" }, { type: "playTone", id: 2 }],
    },
    {
      name: "an approval while waiting is announced",
      events: [working, approval],
      phase: "speaking",
      effects: [{ type: "speak", id: 1, text: "Docs needs approval" }],
    },
    {
      name: "another thread finishing while waiting is announced",
      events: [working, otherDone],
      phase: "speaking",
      effects: [{ type: "speak", id: 1, text: "Docs is done" }],
    },
    {
      name: "an announcement made while waiting returns to waiting",
      events: [working, otherDone, { type: "speechEnded", id: 1 }],
      phase: "waiting",
      effects: [],
    },
  ])("$name", ({ events, phase, effects }) => {
    const result = run(events);
    expect(result.state.phase.kind).toBe(phase);
    expect(result.effects).toEqual(effects);
  });

  it.each<{ name: string; events: HandsFreeEvent[]; effects: HandsFreeEffect[] }>([
    { name: "speaking", events: speakingReply, effects: [{ type: "stopAudio" }] },
    { name: "tone", events: [start], effects: [{ type: "stopAudio" }] },
    { name: "listening", events: listening, effects: [{ type: "cancelRecording" }] },
    {
      name: "transcribing",
      events: [...listening, { type: "done" }],
      effects: [{ type: "cancelRecording" }],
    },
    { name: "sending", events: sending, effects: [] },
    { name: "waiting", events: [working], effects: [] },
    {
      name: "a failed send is held",
      events: unsent,
      effects: [{ type: "notify", message: HANDS_FREE_COPY.abandonedSendFailed("Add a test") }],
    },
    {
      name: "the failed send notice plays",
      events: [...sending, { type: "sendFailed", id: 2 }],
      effects: [
        { type: "stopAudio" },
        { type: "notify", message: HANDS_FREE_COPY.abandonedSendFailed("Add a test") },
      ],
    },
  ])("stop while $name cleans up and turns off", ({ events, effects }) => {
    const result = run([...events, { type: "stop" }]);
    expect(result.state.phase.kind).toBe("off");
    expect(result.effects).toEqual(effects);
  });

  it("never sends without Done", () => {
    const events: HandsFreeEvent[] = [
      ...listening,
      reply("m1"),
      otherDone,
      approval,
      { type: "talk" },
      { type: "speechEnded", id: 1 },
      { type: "toneEnded", id: 1 },
      { type: "transcribed", id: 1, text: "stale", draftId: "d1" },
    ];
    let state = HANDS_FREE_OFF;
    for (const event of events) {
      const result = handsFreeReducer(state, event);
      expect(result.effects.some((effect) => effect.type === "send")).toBe(false);
      state = result.state;
    }
    expect(state.phase.kind).toBe("listening");
  });
});

describe("hands-free races", () => {
  it("reads a reply held while talking mid-turn after the send, then waits for the new turn", () => {
    const held = run([working, { type: "talk" }, { type: "toneEnded", id: 1 }, reply("m1")]);
    expect(held.effects).toEqual([]);
    expect(held.state.phase.kind).toBe("listening");

    const after = run(
      [
        { type: "done" },
        { type: "transcribed", id: 1, text: "Go", draftId: "d1" },
        { type: "sent", id: 2, agentWorking: true },
      ],
      held.state,
    );
    expect(after.effects).toEqual([
      {
        type: "speakReply",
        id: 3,
        environmentId: "e1",
        threadId: "t1",
        messageId: "m1",
        mode: "short",
      },
    ]);
    const read = run([{ type: "speechEnded", id: 3 }], after.state);
    expect(read.state.phase.kind).toBe("waiting");

    const next = run([reply("m2"), { type: "speechEnded", id: 4 }], read.state);
    expect(next.effects).toEqual([{ type: "playTone", id: 5 }]);
  });

  it("tells about the new turn ending without a reply after reading a held reply", () => {
    const { state } = run([
      working,
      { type: "talk" },
      { type: "toneEnded", id: 1 },
      reply("m1"),
      { type: "done" },
      { type: "transcribed", id: 1, text: "Go", draftId: "d1" },
      { type: "sent", id: 2, agentWorking: true },
      reply(null, false, "turn-go"),
    ]);
    const read = run([{ type: "speechEnded", id: 3 }], state);
    expect(read.effects).toEqual([{ type: "speak", id: 4, text: HANDS_FREE_COPY.noReply }]);
    const after = run([{ type: "speechEnded", id: 4 }], read.state);
    expect(after.effects).toEqual([{ type: "playTone", id: 5 }]);
  });

  it("reads the held reply and then the newer turn ending without one after a deduped resend", () => {
    const { state, effects } = run([
      ...unsent,
      reply("m2"),
      reply(null, false, "turn-b"),
      { type: "done" },
      { type: "sent", id: 4, agentWorking: false },
    ]);
    expect(effects).toEqual([
      {
        type: "speakReply",
        id: 5,
        environmentId: "e1",
        threadId: "t1",
        messageId: "m2",
        mode: "short",
      },
    ]);
    const read = run([{ type: "speechEnded", id: 5 }], state);
    expect(read.effects).toEqual([{ type: "speak", id: 6, text: HANDS_FREE_COPY.noReply }]);
    const after = run([{ type: "speechEnded", id: 6 }], read.state);
    expect(after.effects).toEqual([{ type: "playTone", id: 7 }]);
  });

  it("listens after reading a reply to the message that finished before its send was acked", () => {
    const { state, effects } = run([
      ...sending,
      reply("mB"),
      { type: "sent", id: 2, agentWorking: false },
    ]);
    expect(effects).toEqual([
      {
        type: "speakReply",
        id: 3,
        environmentId: "e1",
        threadId: "t1",
        messageId: "mB",
        mode: "short",
      },
    ]);
    const after = run([{ type: "speechEnded", id: 3 }], state);
    expect(after.effects).toEqual([{ type: "playTone", id: 4 }]);
  });

  it("goes quiet after a reply when the platform reports a newer turn running", () => {
    const { state, effects } = run([working, reply("m1", true), { type: "speechEnded", id: 1 }]);
    expect(effects).toEqual([]);
    expect(state.phase.kind).toBe("waiting");
  });

  it("announces other threads after the send, before reading a held reply", () => {
    const { state } = run([...listening, reply("m1"), otherDone, { type: "done" }]);
    expect(state.phase.kind).toBe("transcribing");
    const announced = run(
      [
        { type: "transcribed", id: 1, text: "Go", draftId: "d1" },
        { type: "sent", id: 2, agentWorking: true },
      ],
      state,
    );
    expect(announced.effects).toEqual([{ type: "speak", id: 3, text: "Docs is done" }]);
    const read = run([{ type: "speechEnded", id: 3 }], announced.state);
    expect(read.effects).toEqual([
      {
        type: "speakReply",
        id: 4,
        environmentId: "e1",
        threadId: "t1",
        messageId: "m1",
        mode: "short",
      },
    ]);
  });

  it("reads a reply that finishes while another is being read next, instead of listening", () => {
    const { effects } = run([...speakingReply, reply("m2"), { type: "speechEnded", id: 1 }]);
    expect(effects).toEqual([
      {
        type: "speakReply",
        id: 2,
        environmentId: "e1",
        threadId: "t1",
        messageId: "m2",
        mode: "short",
      },
    ]);
  });

  it("reads a reply only once when its finish event repeats", () => {
    const { state, effects } = run([...speakingReply, reply("m1")]);
    expect(effects).toEqual([]);
    expect(state.pending).toEqual([]);
    const ended = run([{ type: "speechEnded", id: 1 }, { type: "talk" }, reply("m1")], state);
    expect(ended.state.pending).toEqual([]);
  });

  it("announces another thread's turn and an approval only once when their events repeat", () => {
    const { state } = run([working, otherDone, otherDone, approval, approval]);
    expect(state.announcements).toEqual(["Docs needs approval"]);
    const { effects } = run(
      [
        { type: "speechEnded", id: 1 },
        { type: "speechEnded", id: 2 },
      ],
      state,
    );
    expect(effects).toEqual([]);
  });

  it("tells apart threads and approvals with the same id in another environment", () => {
    const elsewhere = { environmentId: "e2", title: "Docs" } as const;
    const { state } = run([
      working,
      { ...reply("m1"), ...elsewhere, turnId: "x" },
      { ...otherDone, environmentId: "e2" },
      { ...approval, environmentId: "e2" },
    ]);
    expect(state.phase).toEqual({
      kind: "speaking",
      id: 1,
      speech: { kind: "notice", text: "Docs is done" },
      then: "wait",
    });
    expect(state.announcements).toEqual(["Docs is done", "Docs needs approval"]);
    expect(run([reply("m1", false, "x"), approval], state).state.pending).toEqual([
      { kind: "reply", messageId: "m1", mode: "short" },
    ]);
  });

  it("tells about a turn without a reply after an announcement made while waiting", () => {
    const { state } = run([working, otherDone, reply(null)]);
    const { effects } = run([{ type: "speechEnded", id: 1 }], state);
    expect(effects).toEqual([{ type: "speak", id: 2, text: HANDS_FREE_COPY.noReply }]);
  });

  it("ignores a transcript that arrives after stop and a restart", () => {
    const { state } = run([
      ...listening,
      { type: "done" },
      { type: "stop" },
      start,
      { type: "toneEnded", id: 2 },
      { type: "done" },
    ]);
    const stale = run([{ type: "transcribed", id: 1, text: "old", draftId: "d1" }], state);
    expect(stale.effects).toEqual([]);
    expect(stale.state.phase).toEqual({ kind: "transcribing", id: 2 });
  });

  it("ignores the end of speech that was skipped", () => {
    const { state, effects } = run([
      ...speakingReply,
      { type: "talk" },
      { type: "speechEnded", id: 1 },
    ]);
    expect(effects).toEqual([]);
    expect(state.phase).toEqual({ kind: "tone", id: 2 });
  });

  it("ignores everything but start while off", () => {
    const { state, effects } = run([
      ...sending,
      { type: "stop" },
      { type: "sent", id: 2, agentWorking: true },
      reply("m9"),
    ]);
    expect(effects).toEqual([]);
    expect(state.phase.kind).toBe("off");
    expect(state.pending).toEqual([]);
  });
});
