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
  /** Empty while off. Thread ids are unique only within their environment. */
  readonly environmentId: string;
  readonly threadId: string;
  readonly readMode: SpeechReadMode;
  /** Whether a turn is running or queued in the thread, so a reply read mid-turn ends quiet. */
  readonly agentWorking: boolean;
  /**
   * The headphones or car went away: nothing is spoken or recorded until the user presses, so
   * nothing reaches the speaker or the built-in microphone. News waits in the queues.
   */
  readonly held: boolean;
  /** The message being sent, or the one that failed to send. */
  readonly draft: Draft | null;
  /**
   * A send that stop abandoned in flight; its failure is still shown with the text, in its own
   * thread, which a later conversation may not share.
   */
  readonly abandonedSend: { readonly id: number; readonly unsent: HandsFreeUnsent } | null;
  /** Spoken at the next safe point, never over listening. */
  readonly announcements: readonly string[];
  /**
   * News from the thread, read at the next safe point, then listening: the newest reply, then a
   * later turn ending without one.
   */
  readonly pending: readonly HandsFreeSpeech[];
  /** The last finished turn per thread key, so a repeated finish event is handled once. */
  readonly finishedTurns: Readonly<Record<string, string>>;
  /** Approval and question keys within their environment. */
  readonly announcedRequests: readonly string[];
  readonly seq: number;
}

/** A message the loop could not send, and the thread it was for. */
export interface HandsFreeUnsent {
  readonly environmentId: string;
  readonly threadId: string;
  readonly text: string;
}

export type HandsFreeRequestKind = "approval" | "question";

export type HandsFreeEvent =
  | {
      readonly type: "start";
      readonly environmentId: string;
      readonly threadId: string;
      readonly readMode: SpeechReadMode;
      readonly agentWorking: boolean;
      /** What the thread already waits on the user for; told first, as nothing else will. */
      readonly request?: {
        readonly requestId: string;
        readonly kind: HandsFreeRequestKind;
        readonly title: string;
      };
    }
  | { readonly type: "stop" }
  /**
   * Skips what is being read or the tone, starts listening while waiting, or resends an unsent
   * message. A single-button press (lock screen, AirPods) maps to `done` while listening and
   * `talk` otherwise.
   */
  | { readonly type: "talk" }
  | { readonly type: "done" }
  /** Later replies, any waiting, and a reply being read now switch to this mode. */
  | { readonly type: "setReadMode"; readonly readMode: SpeechReadMode }
  | { readonly type: "discard" }
  | { readonly type: "rerecord" }
  | { readonly type: "speechEnded"; readonly id: number }
  | { readonly type: "speechFailed"; readonly id: number }
  | { readonly type: "toneEnded"; readonly id: number }
  /** `reopen`: only opening the app can bring the microphone back, so the user is told to. */
  | { readonly type: "recordingFailed"; readonly id: number; readonly reopen?: boolean }
  /**
   * The headphones or car went away and iOS paused audio so it does not move to the speaker.
   * A reply being read goes back to the queue and listening stops unsent; then the loop holds.
   */
  | { readonly type: "audioRouteLost" }
  /** Listening ran for `HANDS_FREE_LISTEN_LIMIT_MS`; what it recorded is dropped, never sent. */
  | { readonly type: "listenTimedOut"; readonly id: number }
  /** The active thread's detail shows whether a turn is running or queued now. */
  | { readonly type: "agentWorkingChanged"; readonly agentWorking: boolean }
  /** The segment came back as digital silence: the microphone stopped delivering audio. */
  | { readonly type: "microphoneSilent"; readonly id: number }
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
  | {
      readonly type: "sent";
      readonly id: number;
      readonly agentWorking: boolean;
      /** Queued behind an approval or question the thread waits on; voice never answers one. */
      readonly queuedBehind?: HandsFreeRequestKind;
    }
  | { readonly type: "sendFailed"; readonly id: number }
  | {
      readonly type: "turnFinished";
      readonly environmentId: string;
      readonly threadId: string;
      readonly title: string;
      readonly turnId: string;
      /** Null when the turn failed, was interrupted, or ended without a reply. */
      readonly messageId: string | null;
      /** Whether another turn is still running or queued in that thread. */
      readonly agentWorking: boolean;
    }
  /** A thread waits on the user: an approval, or a question the agent asked. */
  | {
      readonly type: "inputRequested";
      readonly environmentId: string;
      readonly requestId: string;
      readonly kind: HandsFreeRequestKind;
      readonly title: string;
    };

export type HandsFreeEffect =
  /** A short read whose summary fails reports `speechFailed`; the reducer then retries it in full. */
  | {
      readonly type: "speakReply";
      readonly id: number;
      readonly environmentId: string;
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
      readonly environmentId: string;
      readonly threadId: string;
      readonly text: string;
    }
  /** A quiet on-screen notice, not spoken; `unsent` is a message the platform should keep. */
  | { readonly type: "notify"; readonly message: string; readonly unsent?: HandsFreeUnsent };

export interface HandsFreeStep {
  readonly state: HandsFreeState;
  readonly effects: readonly HandsFreeEffect[];
}

/** How long one listening turn may run; a forgotten one must not record for hours. */
export const HANDS_FREE_LISTEN_LIMIT_MS = 5 * 60_000;

export const HANDS_FREE_COPY = {
  nothingHeard: "I didn't catch anything.",
  transcriptionFailed: "I couldn't understand that. Try again.",
  sendFailed: "Your message wasn't sent. Press Done to send it again.",
  abandonedSendFailed: (text: string) => `Your message wasn't sent: ${text}`,
  recordingFailed: "The microphone isn't available.",
  microphoneSilent: "The microphone stopped. Open T3 Code to turn it back on.",
  listenTimedOut: "I stopped listening after 5 minutes. Nothing was sent.",
  routeLostWhileListening:
    "Listening stopped when the audio device disconnected. Nothing was sent.",
  shortUnavailable: "The short version isn't available. Reading the full reply.",
  replyUnavailable: "This reply couldn't be read aloud.",
  noReply: "The agent stopped without a reply.",
  threadDone: (title: string) => `${title} is done`,
  threadStopped: (title: string) => `${title} stopped without a reply`,
  needsApproval: (title: string) => `${title} needs approval`,
  hasQuestion: (title: string) => `${title} has a question`,
  queuedBehind: (kind: HandsFreeRequestKind) =>
    kind === "approval"
      ? "Queued. Answer the approval on screen first."
      : "Queued. Answer the question on screen first.",
} as const;

export const HANDS_FREE_OFF: HandsFreeState = {
  phase: { kind: "off" },
  environmentId: "",
  threadId: "",
  readMode: "short",
  agentWorking: false,
  held: false,
  draft: null,
  abandonedSend: null,
  announcements: [],
  pending: [],
  finishedTurns: {},
  announcedRequests: [],
  seq: 0,
};

const step = (state: HandsFreeState, ...effects: HandsFreeEffect[]): HandsFreeStep => ({
  state,
  effects,
});

function speak(state: HandsFreeState, speech: HandsFreeSpeech, then: Next): HandsFreeStep {
  if (state.held) {
    if (speech.kind !== "notice")
      return quiet({ ...state, pending: [speech, ...state.pending] }, then);
    return withEffectFirst(quiet(state, then), { type: "notify", message: speech.text });
  }
  const id = state.seq + 1;
  const next = { ...state, seq: id, phase: { kind: "speaking", id, speech, then } as const };
  return speech.kind === "reply"
    ? step(next, {
        type: "speakReply",
        id,
        environmentId: state.environmentId,
        threadId: state.threadId,
        messageId: speech.messageId,
        mode: speech.mode,
      })
    : step(next, { type: "speak", id, text: speechText(speech) });
}

const speechText = (speech: Exclude<HandsFreeSpeech, { kind: "reply" }>) =>
  speech.kind === "noReply" ? HANDS_FREE_COPY.noReply : speech.text;

/** Held: waits for a press instead of speaking or listening. */
const quiet = (state: HandsFreeState, next: Next): HandsFreeStep =>
  step({ ...state, phase: { kind: next === "unsent" ? "unsent" : "waiting" } });

function tone(state: HandsFreeState): HandsFreeStep {
  if (state.held) return quiet(state, "listen");
  const id = state.seq + 1;
  return step({ ...state, seq: id, phase: { kind: "tone", id } }, { type: "playTone", id });
}

function send(state: HandsFreeState, draft: Draft): HandsFreeStep {
  const id = state.seq + 1;
  return step(
    { ...state, seq: id, draft, phase: { kind: "sending", id } },
    {
      type: "send",
      id,
      draftId: draft.draftId,
      environmentId: state.environmentId,
      threadId: state.threadId,
      text: draft.text,
    },
  );
}

/** A safe point: announcements first, then what the thread left pending, then `next`. */
function advance(state: HandsFreeState, next: Next): HandsFreeStep {
  if (state.held) return quiet(state, next);
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

const scopedKey = (environmentId: string, id: string) => JSON.stringify([environmentId, id]);

function turnFinished(
  state: HandsFreeState,
  event: Extract<HandsFreeEvent, { type: "turnFinished" }>,
): HandsFreeStep {
  const threadKey = scopedKey(event.environmentId, event.threadId);
  if (state.finishedTurns[threadKey] === event.turnId) return step(state);
  const known = {
    ...state,
    finishedTurns: { ...state.finishedTurns, [threadKey]: event.turnId },
  };
  if (event.environmentId !== state.environmentId || event.threadId !== state.threadId) {
    const text = event.messageId
      ? HANDS_FREE_COPY.threadDone(event.title)
      : HANDS_FREE_COPY.threadStopped(event.title);
    return announce(known, text);
  }
  const current = { ...known, agentWorking: event.agentWorking };
  const { phase } = current;
  if (event.messageId !== null) {
    const reply = { kind: "reply", messageId: event.messageId, mode: state.readMode } as const;
    return phase.kind === "waiting" && !current.held
      ? speak(current, reply, "listen")
      : step({ ...current, pending: [reply] });
  }
  if (event.agentWorking) return step(current);
  const notice = { kind: "noReply" } as const;
  if (phase.kind === "waiting" && !current.held) return speak(current, notice, "listen");
  const replies = current.pending.filter((speech) => speech.kind === "reply");
  return step({ ...current, pending: [...replies, notice] });
}

const PRESSES = new Set<HandsFreeEvent["type"]>(["talk", "done", "discard", "rerecord"]);

export function handsFreeReducer(current: HandsFreeState, event: HandsFreeEvent): HandsFreeStep {
  // A press means the user is back on a route they chose, so the loop speaks again.
  const state = current.held && PRESSES.has(event.type) ? { ...current, held: false } : current;
  const { phase } = state;

  if ((event.type === "sent" || event.type === "sendFailed") && state.abandonedSend) {
    const { id, unsent } = state.abandonedSend;
    if (event.id === id) {
      const cleared = { ...state, abandonedSend: null };
      return event.type === "sent" ? step(cleared) : step(cleared, unsentNotice(unsent));
    }
  }

  if (event.type === "start") {
    if (phase.kind !== "off") return step(state);
    const started = {
      ...HANDS_FREE_OFF,
      seq: state.seq,
      abandonedSend: state.abandonedSend,
      environmentId: event.environmentId,
      threadId: event.threadId,
      readMode: event.readMode,
      agentWorking: event.agentWorking,
    };
    const { request } = event;
    if (request) {
      const known = {
        ...started,
        announcedRequests: [scopedKey(event.environmentId, request.requestId)],
      };
      return speak(
        known,
        { kind: "notice", text: requestText(request.kind, request.title) },
        event.agentWorking ? "wait" : "listen",
      );
    }
    return event.agentWorking ? step({ ...started, phase: { kind: "waiting" } }) : tone(started);
  }
  if (phase.kind === "off") return step(state);

  switch (event.type) {
    case "stop": {
      const abandonedSend =
        phase.kind === "sending" && state.draft
          ? { id: phase.id, unsent: unsentOf(state, state.draft) }
          : state.abandonedSend;
      const off = step({ ...HANDS_FREE_OFF, seq: state.seq, abandonedSend }, ...cleanup(phase));
      // Only a draft that already failed is held here; its text was never shown.
      return canRedo(phase) && state.draft
        ? step(off.state, ...off.effects, unsentNotice(unsentOf(state, state.draft)))
        : off;
    }

    case "talk":
      if (canRedo(phase) && state.draft) return resend(state, phase, state.draft);
      if (phase.kind === "speaking") {
        return withEffectFirst(tone(state), { type: "stopAudio" });
      }
      // Skipping the tone also gets out of one that never reports its end.
      if (phase.kind === "tone") {
        return step(
          { ...state, phase: { kind: "listening", id: phase.id } },
          { type: "stopAudio" },
          { type: "startRecording", id: phase.id },
        );
      }
      // Held news is read first, then listening.
      return phase.kind === "waiting" ? advance(state, "listen") : step(state);

    case "done":
      if (phase.kind === "listening") {
        return step(
          { ...state, phase: { kind: "transcribing", id: phase.id } },
          { type: "finishRecording", id: phase.id },
        );
      }
      if (!canRedo(phase) || !state.draft) return step(state);
      return resend(state, phase, state.draft);

    case "setReadMode": {
      if (event.readMode === state.readMode) return step(state);
      const withMode = (speech: HandsFreeSpeech) =>
        speech.kind === "reply" ? { ...speech, mode: event.readMode } : speech;
      const next = { ...state, readMode: event.readMode, pending: state.pending.map(withMode) };
      if (phase.kind !== "speaking" || phase.speech.kind !== "reply") return step(next);
      return withEffectFirst(speak(next, withMode(phase.speech), phase.then), {
        type: "stopAudio",
      });
    }

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
      return speak(
        state,
        {
          kind: "notice",
          text: event.reopen ? HANDS_FREE_COPY.microphoneSilent : HANDS_FREE_COPY.recordingFailed,
        },
        "wait",
      );

    case "audioRouteLost": {
      const held = { ...state, held: true };
      if (phase.kind === "speaking") {
        const { speech } = phase;
        // A reply cut off here is read again after the next press; a notice is not.
        const pending = speech.kind === "notice" ? held.pending : [speech, ...held.pending];
        return withEffectFirst(quiet({ ...held, pending }, phase.then), { type: "stopAudio" });
      }
      if (phase.kind === "tone") {
        return withEffectFirst(quiet(held, "wait"), { type: "stopAudio" });
      }
      if (phase.kind === "listening") {
        return step(
          { ...held, phase: { kind: "waiting" } },
          { type: "cancelRecording" },
          { type: "notify", message: HANDS_FREE_COPY.routeLostWhileListening },
        );
      }
      return step(held);
    }

    case "listenTimedOut":
      if (phase.kind !== "listening" || phase.id !== event.id) return step(state);
      return withEffectFirst(
        speak(state, { kind: "notice", text: HANDS_FREE_COPY.listenTimedOut }, "wait"),
        { type: "cancelRecording" },
      );

    case "agentWorkingChanged":
      // A send reads it itself once the thread applied its result.
      if (phase.kind === "sending" || event.agentWorking === state.agentWorking) {
        return step(state);
      }
      return step({ ...state, agentWorking: event.agentWorking });

    case "transcribed": {
      if (phase.kind !== "transcribing" || phase.id !== event.id) return step(state);
      const text = event.text.trim();
      // Quiet after, so a press by mistake in a noisy car cannot loop into listening again.
      if (!text)
        return speak(state, { kind: "notice", text: HANDS_FREE_COPY.nothingHeard }, "wait");
      return send(state, { draftId: event.draftId, text });
    }

    case "microphoneSilent":
      if (phase.kind !== "transcribing" || phase.id !== event.id) return step(state);
      return speak(state, { kind: "notice", text: HANDS_FREE_COPY.microphoneSilent }, "wait");

    case "transcriptionFailed":
      if (phase.kind !== "transcribing" || phase.id !== event.id) return step(state);
      return speak(state, { kind: "notice", text: HANDS_FREE_COPY.transcriptionFailed }, "listen");

    case "sent": {
      if (phase.kind !== "sending" || phase.id !== event.id) return step(state);
      const { agentWorking, queuedBehind } = event;
      const announcements = queuedBehind
        ? [HANDS_FREE_COPY.queuedBehind(queuedBehind), ...state.announcements]
        : state.announcements;
      return advance(
        { ...state, draft: null, agentWorking, announcements },
        agentWorking ? "wait" : "listen",
      );
    }

    case "sendFailed": {
      if (phase.kind !== "sending" || phase.id !== event.id || !state.draft) return step(state);
      return speak(state, { kind: "notice", text: HANDS_FREE_COPY.sendFailed }, "unsent");
    }

    case "turnFinished":
      return turnFinished(state, event);

    case "inputRequested": {
      const requestKey = scopedKey(event.environmentId, event.requestId);
      if (state.announcedRequests.includes(requestKey)) return step(state);
      const known = {
        ...state,
        announcedRequests: [...state.announcedRequests, requestKey],
      };
      return announce(known, requestText(event.kind, event.title));
    }
  }
}

/** A single-button press (lock screen, AirPods, car): Done while listening, talk otherwise. */
export function handsFreePressEvent(phase: HandsFreePhase): HandsFreeEvent {
  return phase.kind === "listening" ? { type: "done" } : { type: "talk" };
}

const requestText = (kind: HandsFreeRequestKind, title: string) =>
  kind === "approval" ? HANDS_FREE_COPY.needsApproval(title) : HANDS_FREE_COPY.hasQuestion(title);

const unsentOf = (state: HandsFreeState, draft: Draft): HandsFreeUnsent => ({
  environmentId: state.environmentId,
  threadId: state.threadId,
  text: draft.text,
});

const unsentNotice = (unsent: HandsFreeUnsent): HandsFreeEffect => ({
  type: "notify",
  message: HANDS_FREE_COPY.abandonedSendFailed(unsent.text),
  unsent,
});

function resend(state: HandsFreeState, phase: HandsFreePhase, draft: Draft): HandsFreeStep {
  const sent = send(state, draft);
  return phase.kind === "speaking" ? withEffectFirst(sent, { type: "stopAudio" }) : sent;
}

function withEffectFirst(result: HandsFreeStep, effect: HandsFreeEffect): HandsFreeStep {
  return { state: result.state, effects: [effect, ...result.effects] };
}
