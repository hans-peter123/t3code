import type { SpeechReadMode } from "./settings.ts";

/**
 * The hands-free loop as a pure reducer: read the reply, tone, listen until the user presses
 * Done, send, wait for the agent, repeat. The platform runs the effects and feeds the results
 * back as events carrying the effect's `id`; results for any other id are stale and ignored.
 * Ids restart with each reducer instance, so its effect runner must not outlive it.
 */

/** Where to go after speaking: record, stay quiet, or offer to resend an unsent message. */
type Next = "listen" | "wait" | "unsent";

export type HandsFreeSpeech =
  | { readonly kind: "reply"; readonly messageId: string; readonly mode: SpeechReadMode }
  | { readonly kind: "notice"; readonly text: string }
  /** The active thread's turn ended without a reply. */
  | { readonly kind: "noReply" };

export type HandsFreePhase =
  | { readonly kind: "off" }
  | {
      readonly kind: "speaking";
      readonly id: number;
      readonly speech: HandsFreeSpeech;
      readonly then: Next;
    }
  | { readonly kind: "tone"; readonly id: number }
  | { readonly kind: "listening"; readonly id: number }
  | { readonly kind: "transcribing"; readonly id: number }
  | { readonly kind: "sending"; readonly id: number }
  /** A send failed; Done or talk resends it, Re-record records a new one, Discard drops it. */
  | { readonly kind: "unsent" }
  | { readonly kind: "waiting" };

interface Draft {
  readonly draftId: string;
  readonly text: string;
}

export interface HandsFreeState {
  readonly phase: HandsFreePhase;
  /** Empty while off. */
  readonly threadId: string;
  readonly readMode: SpeechReadMode;
  /** Whether a turn is running or queued in the thread, so a reply read mid-turn ends quiet. */
  readonly agentWorking: boolean;
  /** The message being sent, or the one that failed to send. */
  readonly draft: Draft | null;
  /** A send that stop abandoned in flight; its failure is still shown with the text. */
  readonly abandonedSend: { readonly id: number; readonly text: string } | null;
  /** Spoken at the next safe point, never over listening. */
  readonly announcements: readonly string[];
  /**
   * News from the thread, read at the next safe point, then listening: the newest reply, then a
   * later turn ending without one.
   */
  readonly pending: readonly HandsFreeSpeech[];
  /** The last finished turn per thread, so a repeated finish event is handled once. */
  readonly finishedTurns: Readonly<Record<string, string>>;
  readonly announcedApprovals: readonly string[];
  readonly seq: number;
}

export type HandsFreeEvent =
  | {
      readonly type: "start";
      readonly threadId: string;
      readonly readMode: SpeechReadMode;
      readonly agentWorking: boolean;
    }
  | { readonly type: "stop" }
  /**
   * Skips what is being read, starts listening while waiting, or resends an unsent message. A
   * single-button press (lock screen, AirPods) maps to `done` while listening and `talk` otherwise.
   */
  | { readonly type: "talk" }
  | { readonly type: "done" }
  | { readonly type: "discard" }
  | { readonly type: "rerecord" }
  | { readonly type: "speechEnded"; readonly id: number }
  | { readonly type: "speechFailed"; readonly id: number }
  | { readonly type: "toneEnded"; readonly id: number }
  | { readonly type: "recordingFailed"; readonly id: number }
  /** `draftId` is a fresh unique id the platform mints for the new message. */
  | {
      readonly type: "transcribed";
      readonly id: number;
      readonly text: string;
      readonly draftId: string;
    }
  | { readonly type: "transcriptionFailed"; readonly id: number }
  /**
   * `agentWorking` is read from the thread once it has applied the command's result sequence, after
   * delivering any `turnFinished` that state shows. A resend the server already ran is deduped.
   */
  | { readonly type: "sent"; readonly id: number; readonly agentWorking: boolean }
  | { readonly type: "sendFailed"; readonly id: number }
  | {
      readonly type: "turnFinished";
      readonly threadId: string;
      readonly title: string;
      readonly turnId: string;
      /** Null when the turn failed, was interrupted, or ended without a reply. */
      readonly messageId: string | null;
      /** Whether another turn is still running or queued in that thread. */
      readonly agentWorking: boolean;
    }
  | { readonly type: "approvalRequested"; readonly requestId: string; readonly title: string };

export type HandsFreeEffect =
  | {
      readonly type: "speakReply";
      readonly id: number;
      readonly threadId: string;
      readonly messageId: string;
      readonly mode: SpeechReadMode;
    }
  | { readonly type: "speak"; readonly id: number; readonly text: string }
  | { readonly type: "playTone"; readonly id: number }
  | { readonly type: "stopAudio" }
  | { readonly type: "startRecording"; readonly id: number }
  /** Stops recording and transcribes it, answered by `transcribed` or `transcriptionFailed`. */
  | { readonly type: "finishRecording"; readonly id: number }
  /** Drops the recording and any transcription in flight. */
  | { readonly type: "cancelRecording" }
  /**
   * A resend repeats `draftId`; the platform uses it as the command id so the server's command
   * receipt drops a resend of a message it already accepted.
   */
  | {
      readonly type: "send";
      readonly id: number;
      readonly draftId: string;
      readonly threadId: string;
      readonly text: string;
    }
  /** A quiet on-screen notice, not spoken. */
  | { readonly type: "notify"; readonly message: string };

export interface HandsFreeStep {
  readonly state: HandsFreeState;
  readonly effects: readonly HandsFreeEffect[];
}

export const HANDS_FREE_COPY = {
  nothingHeard: "I didn't catch anything. Try again.",
  transcriptionFailed: "I couldn't understand that. Try again.",
  sendFailed: "Your message wasn't sent. Press Done to send it again.",
  abandonedSendFailed: (text: string) => `Your message wasn't sent: ${text}`,
  recordingFailed: "The microphone isn't available.",
  shortUnavailable: "The short version isn't available. Reading the full reply.",
  replyUnavailable: "This reply couldn't be read aloud.",
  noReply: "The agent stopped without a reply.",
  threadDone: (title: string) => `${title} is done`,
  threadStopped: (title: string) => `${title} stopped without a reply`,
  needsApproval: (title: string) => `${title} needs approval`,
} as const;

export const HANDS_FREE_OFF: HandsFreeState = {
  phase: { kind: "off" },
  threadId: "",
  readMode: "short",
  agentWorking: false,
  draft: null,
  abandonedSend: null,
  announcements: [],
  pending: [],
  finishedTurns: {},
  announcedApprovals: [],
  seq: 0,
};

const step = (state: HandsFreeState, ...effects: HandsFreeEffect[]): HandsFreeStep => ({
  state,
  effects,
});

function speak(state: HandsFreeState, speech: HandsFreeSpeech, then: Next): HandsFreeStep {
  const id = state.seq + 1;
  const next = { ...state, seq: id, phase: { kind: "speaking", id, speech, then } as const };
  return speech.kind === "reply"
    ? step(next, {
        type: "speakReply",
        id,
        threadId: state.threadId,
        messageId: speech.messageId,
        mode: speech.mode,
      })
    : step(next, { type: "speak", id, text: speechText(speech) });
}

const speechText = (speech: Exclude<HandsFreeSpeech, { kind: "reply" }>) =>
  speech.kind === "noReply" ? HANDS_FREE_COPY.noReply : speech.text;

function tone(state: HandsFreeState): HandsFreeStep {
  const id = state.seq + 1;
  return step({ ...state, seq: id, phase: { kind: "tone", id } }, { type: "playTone", id });
}

function send(state: HandsFreeState, draft: Draft): HandsFreeStep {
  const id = state.seq + 1;
  return step(
    { ...state, seq: id, draft, phase: { kind: "sending", id } },
    { type: "send", id, draftId: draft.draftId, threadId: state.threadId, text: draft.text },
  );
}

/** A safe point: announcements first, then what the thread left pending, then `next`. */
function advance(state: HandsFreeState, next: Next): HandsFreeStep {
  const [announcement, ...rest] = state.announcements;
  if (announcement !== undefined) {
    return speak({ ...state, announcements: rest }, { kind: "notice", text: announcement }, next);
  }
  const [news, ...later] = state.pending;
  if (news !== undefined && next !== "unsent") {
    return speak({ ...state, pending: later }, news, "listen");
  }
  if (next === "listen") return tone(state);
  return step({ ...state, phase: { kind: next === "wait" ? "waiting" : "unsent" } });
}

/** News from the thread read while the agent is still on a newer turn goes quiet, not listening. */
function afterSpeech(state: HandsFreeState, phase: { speech: HandsFreeSpeech; then: Next }) {
  const fromThread = phase.speech.kind === "reply" || phase.speech.kind === "noReply";
  const midTurn = fromThread && phase.then === "listen" && state.agentWorking;
  return advance(state, midTurn ? "wait" : phase.then);
}

function announce(state: HandsFreeState, text: string): HandsFreeStep {
  const queued = { ...state, announcements: [...state.announcements, text] };
  const { kind } = state.phase;
  return kind === "waiting" || kind === "unsent"
    ? advance(queued, kind === "waiting" ? "wait" : "unsent")
    : step(queued);
}

function cleanup(phase: HandsFreePhase): HandsFreeEffect[] {
  switch (phase.kind) {
    case "speaking":
    case "tone":
      return [{ type: "stopAudio" }];
    case "listening":
    case "transcribing":
      return [{ type: "cancelRecording" }];
    default:
      return [];
  }
}

/** Listening, or holding an unsent message (also while its notice plays). */
const canRedo = (phase: HandsFreePhase) =>
  phase.kind === "listening" ||
  phase.kind === "unsent" ||
  (phase.kind === "speaking" && phase.then === "unsent");

function turnFinished(
  state: HandsFreeState,
  event: Extract<HandsFreeEvent, { type: "turnFinished" }>,
): HandsFreeStep {
  if (state.finishedTurns[event.threadId] === event.turnId) return step(state);
  const known = {
    ...state,
    finishedTurns: { ...state.finishedTurns, [event.threadId]: event.turnId },
  };
  if (event.threadId !== state.threadId) {
    const text = event.messageId
      ? HANDS_FREE_COPY.threadDone(event.title)
      : HANDS_FREE_COPY.threadStopped(event.title);
    return announce(known, text);
  }
  const current = { ...known, agentWorking: event.agentWorking };
  const { phase } = current;
  if (event.messageId !== null) {
    const reply = { kind: "reply", messageId: event.messageId, mode: state.readMode } as const;
    return phase.kind === "waiting"
      ? speak(current, reply, "listen")
      : step({ ...current, pending: [reply] });
  }
  if (event.agentWorking) return step(current);
  const notice = { kind: "noReply" } as const;
  if (phase.kind === "waiting") return speak(current, notice, "listen");
  const replies = current.pending.filter((speech) => speech.kind === "reply");
  return step({ ...current, pending: [...replies, notice] });
}

export function handsFreeReducer(state: HandsFreeState, event: HandsFreeEvent): HandsFreeStep {
  const { phase } = state;

  if ((event.type === "sent" || event.type === "sendFailed") && state.abandonedSend) {
    const { id, text } = state.abandonedSend;
    if (event.id === id) {
      const cleared = { ...state, abandonedSend: null };
      return event.type === "sent"
        ? step(cleared)
        : step(cleared, { type: "notify", message: HANDS_FREE_COPY.abandonedSendFailed(text) });
    }
  }

  if (event.type === "start") {
    if (phase.kind !== "off") return step(state);
    const started = {
      ...HANDS_FREE_OFF,
      seq: state.seq,
      abandonedSend: state.abandonedSend,
      threadId: event.threadId,
      readMode: event.readMode,
      agentWorking: event.agentWorking,
    };
    return event.agentWorking ? step({ ...started, phase: { kind: "waiting" } }) : tone(started);
  }
  if (phase.kind === "off") return step(state);

  switch (event.type) {
    case "stop": {
      const abandonedSend =
        phase.kind === "sending" && state.draft
          ? { id: phase.id, text: state.draft.text }
          : state.abandonedSend;
      const off = step({ ...HANDS_FREE_OFF, seq: state.seq, abandonedSend }, ...cleanup(phase));
      // Only a draft that already failed is held here; its text was never shown.
      return canRedo(phase) && state.draft
        ? step(off.state, ...off.effects, {
            type: "notify",
            message: HANDS_FREE_COPY.abandonedSendFailed(state.draft.text),
          })
        : off;
    }

    case "talk":
      if (canRedo(phase) && state.draft) return resend(state, phase, state.draft);
      if (phase.kind === "speaking") {
        return withEffectFirst(tone(state), { type: "stopAudio" });
      }
      return phase.kind === "waiting" ? tone(state) : step(state);

    case "done":
      if (phase.kind === "listening") {
        return step(
          { ...state, phase: { kind: "transcribing", id: phase.id } },
          { type: "finishRecording", id: phase.id },
        );
      }
      if (!canRedo(phase) || !state.draft) return step(state);
      return resend(state, phase, state.draft);

    case "discard":
    case "rerecord": {
      if (!canRedo(phase)) return step(state);
      const dropped = { ...state, draft: null };
      const result = event.type === "discard" ? advance(dropped, "wait") : tone(dropped);
      const [stop] = cleanup(phase);
      return stop ? withEffectFirst(result, stop) : result;
    }

    case "speechEnded":
      if (phase.kind !== "speaking" || phase.id !== event.id) return step(state);
      return afterSpeech(state, phase);

    case "speechFailed": {
      if (phase.kind !== "speaking" || phase.id !== event.id) return step(state);
      const { speech } = phase;
      if (speech.kind === "reply" && speech.mode === "short") {
        return withEffectFirst(speak(state, { ...speech, mode: "full" }, phase.then), {
          type: "notify",
          message: HANDS_FREE_COPY.shortUnavailable,
        });
      }
      return withEffectFirst(afterSpeech(state, phase), {
        type: "notify",
        message: speech.kind === "reply" ? HANDS_FREE_COPY.replyUnavailable : speechText(speech),
      });
    }

    case "toneEnded":
      if (phase.kind !== "tone" || phase.id !== event.id) return step(state);
      return step(
        { ...state, phase: { kind: "listening", id: event.id } },
        { type: "startRecording", id: event.id },
      );

    case "recordingFailed":
      if (phase.kind !== "listening" || phase.id !== event.id) return step(state);
      return speak(state, { kind: "notice", text: HANDS_FREE_COPY.recordingFailed }, "wait");

    case "transcribed": {
      if (phase.kind !== "transcribing" || phase.id !== event.id) return step(state);
      const text = event.text.trim();
      if (!text)
        return speak(state, { kind: "notice", text: HANDS_FREE_COPY.nothingHeard }, "listen");
      return send(state, { draftId: event.draftId, text });
    }

    case "transcriptionFailed":
      if (phase.kind !== "transcribing" || phase.id !== event.id) return step(state);
      return speak(state, { kind: "notice", text: HANDS_FREE_COPY.transcriptionFailed }, "listen");

    case "sent": {
      if (phase.kind !== "sending" || phase.id !== event.id) return step(state);
      const { agentWorking } = event;
      return advance({ ...state, draft: null, agentWorking }, agentWorking ? "wait" : "listen");
    }

    case "sendFailed": {
      if (phase.kind !== "sending" || phase.id !== event.id || !state.draft) return step(state);
      return speak(state, { kind: "notice", text: HANDS_FREE_COPY.sendFailed }, "unsent");
    }

    case "turnFinished":
      return turnFinished(state, event);

    case "approvalRequested": {
      if (state.announcedApprovals.includes(event.requestId)) return step(state);
      const known = {
        ...state,
        announcedApprovals: [...state.announcedApprovals, event.requestId],
      };
      return announce(known, HANDS_FREE_COPY.needsApproval(event.title));
    }
  }
}

function resend(state: HandsFreeState, phase: HandsFreePhase, draft: Draft): HandsFreeStep {
  const sent = send(state, draft);
  return phase.kind === "speaking" ? withEffectFirst(sent, { type: "stopAudio" }) : sent;
}

function withEffectFirst(result: HandsFreeStep, effect: HandsFreeEffect): HandsFreeStep {
  return { state: result.state, effects: [effect, ...result.effects] };
}
