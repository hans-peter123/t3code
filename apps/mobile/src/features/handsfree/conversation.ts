import {
  activeSpeechProvider,
  encodeWav,
  HANDS_FREE_COPY,
  HANDS_FREE_LISTEN_LIMIT_MS,
  HANDS_FREE_OFF,
  handsFreePressEvent,
  handsFreeReducer,
  handsFreeSeedThreadFromShell,
  handsFreeThreadEvents,
  handsFreeThreadFromDetail,
  handsFreeThreadFromShell,
  handsFreeThreadRequest,
  handsFreeWorkingAfterSend,
  NO_THREADS_SEEN,
  pcmDuration,
  planMessageSpeech,
  silentWav,
  speechProviderProblem,
  synthesizeSpeechParts,
  type HandsFreeEffect,
  type HandsFreeEvent,
  type HandsFreeState,
  type HandsFreeThreadRequest,
  type HandsFreeThreadSnapshot,
  type HandsFreeThreadsSeen,
  type HandsFreeUnsent,
  type SpeechReadMode,
} from "@t3tools/client-runtime/speech";
import { resolveFollowUpDispatchMode } from "@t3tools/client-runtime/state/composer-dispatch";
import {
  threadRuntimeIsActive,
  type EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import {
  deriveThreadActivityRun,
  deriveThreadRuntime,
} from "@t3tools/client-runtime/state/thread-execution";
import { deriveThreadTitleSeed } from "@t3tools/client-runtime/operations";
import type { PreparedVoiceTranscription } from "@t3tools/client-runtime/voice-input";
import {
  AuthOrchestrationOperateScope,
  CommandId,
  EnvironmentId,
  MessageId,
  ThreadId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import { createAudioPlayer, requestRecordingPermissionsAsync, type AudioPlayer } from "expo-audio";
import { Directory, File, Paths } from "expo-file-system";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { useSyncExternalStore } from "react";
import { AppState } from "react-native";

import {
  acquireAudioSession,
  activateAudioSession,
  audioSessionOwnerKind,
  pauseAudioPlayer,
  releaseAudioSession,
} from "../../lib/audioSession";
import { DEFAULT_FOLLOW_UP_BEHAVIOR } from "../../lib/followUpBehavior";
import { isModelSelectionUnavailable } from "../../lib/modelOptions";
import { scopedThreadKey } from "../../lib/scopedEntities";
import { uuidv4 } from "../../lib/uuid";
import { VoiceCapture, type VoiceCaptureState } from "../../native/voiceCapture";
import { appAtomRegistry } from "../../state/atom-registry";
import { mobilePreferencesAtom } from "../../state/preferences";
import { serverEnvironment } from "../../state/server";
import { readEnvironmentScope } from "../../state/session";
import { resolveQueuedThreadSettings } from "../../state/thread-outbox-model";
import {
  environmentThreadDetails,
  environmentThreadShells,
  environmentThreads,
  threadEnvironment,
} from "../../state/threads";
import {
  getComposerDraftSnapshot,
  mergeComposerDraftContent,
} from "../../state/use-composer-drafts";
import { stopSpeech } from "../speech/speechPlayback";
import { currentSpeechSettings, loadSpeechSettings } from "../speech/speechSettings";
import { getVoiceTranscriber } from "../speech/speechTranscription";
import { canSummarize, loadSpokenSummary } from "../speech/spokenSummary";
import { conversationBlocker } from "./conversationAvailability";

/** What the conversation screen and the thread's banner show. */
export interface ConversationView {
  readonly ref: ScopedThreadRef | null;
  readonly title: string;
  readonly state: HandsFreeState;
  /**
   * The latest quiet notice and the thread it is about, such as a send that failed after the
   * conversation ended, which may be another thread than the one talked with now.
   */
  readonly notice: { readonly text: string; readonly ref: ScopedThreadRef } | null;
  /** What the thread talked with waits on the user for. */
  readonly request: HandsFreeThreadRequest | null;
  /** The microphone is held by a call or Siri. */
  readonly interrupted: boolean;
  /** Restarting the microphone failed; opening the app tries again. */
  readonly microphoneError: string | null;
}

const IDLE_VIEW: ConversationView = {
  ref: null,
  title: "",
  state: HANDS_FREE_OFF,
  notice: null,
  request: null,
  interrupted: false,
  microphoneError: null,
};

// A segment shorter than this, or quieter, holds nothing worth transcribing.
const MIN_SEGMENT_SECONDS = 0.4;
const MIN_SEGMENT_PEAK = 0.02;
// Even a quiet room reads far above this (about -80 dB); below it the input delivers nothing.
const DEAD_SEGMENT_PEAK = 0.0001;
/** expo-audio's own pauses for a call, Siri or a lost route are marked natively within this. */
const PRESS_SETTLE_MS = 250;
const AUDIO_DIRECTORY = "hands-free";
const TONE_SECONDS = 0.18;
/** The player's item length matches ours within this, which tells its status apart. */
const DURATION_TOLERANCE = 0.1;
/**
 * A conversation with nothing happening this long ends, freeing the microphone. Changes in its
 * thread count as something happening, so a thread that stops updating (deleted, disconnected)
 * cannot keep it alive.
 */
const IDLE_END_MS = 30 * 60_000;
const IDLE_END_NOTICE = "The conversation ended after 30 minutes without activity.";
/** The falling tone that tells a listener without the screen that the conversation ended. */
const END_NOTES = [660, 440];

/** One note per frequency, each `TONE_SECONDS` long. */
function toneWav(notes: readonly number[]): Uint8Array {
  const sampleRate = 16_000;
  const length = Math.round(sampleRate * TONE_SECONDS);
  const samples = new Uint8Array(length * notes.length * 2);
  const view = new DataView(samples.buffer);
  notes.forEach((frequency, note) => {
    for (let i = 0; i < length; i++) {
      const fade = Math.min(1, i / 400, (length - i) / 400);
      const sample = Math.sin((2 * Math.PI * frequency * i) / sampleRate) * 9000 * fade;
      view.setInt16((note * length + i) * 2, sample, true);
    }
  });
  return encodeWav([{ format: { sampleRate, channels: 1 }, samples }]);
}

function audioDirectory(): Directory {
  const directory = new Directory(Paths.cache, AUDIO_DIRECTORY);
  directory.create({ idempotent: true, intermediates: true });
  return directory;
}

function writeAudio(name: string, bytes: Uint8Array): string {
  const file = new File(audioDirectory(), name);
  if (file.exists) file.delete();
  file.write(bytes);
  return file.uri;
}

function deleteFile(uri: string | null) {
  if (!uri) return;
  try {
    new File(uri).delete();
  } catch {}
}

/** What is playing on the voice player: speech parts as they arrive, or the tone. */
interface Clip {
  readonly id: number;
  readonly kind: "speech" | "tone";
  readonly controller: AbortController;
  readonly parts: string[];
  /** Seconds per part, to ignore what the player reports about the item it replaced. */
  readonly durations: number[];
  next: number;
  /** Every part has arrived. */
  done: boolean;
  /** The player finished the parts so far and waits for the next. */
  starved: boolean;
}

/**
 * One hands-free conversation at a time, owned by this module so it outlives the screen that
 * started it and keeps running while the iPhone is locked. It holds the audio session for the
 * whole conversation, the microphone started in the foreground, a silent looping player that
 * keeps the lock screen and headset controls, and a voice player for speech and the tone.
 */
class Conversation {
  private state: HandsFreeState = HANDS_FREE_OFF;
  private view: ConversationView = IDLE_VIEW;
  private readonly listeners = new Set<() => void>();

  private ref: ScopedThreadRef | null = null;
  private token: ReturnType<typeof acquireAudioSession> | null = null;
  private keepAlive: AudioPlayer | null = null;
  private voice: AudioPlayer | null = null;
  private clip: Clip | null = null;
  private teardown: (() => void)[] = [];
  private seen: HandsFreeThreadsSeen = NO_THREADS_SEEN;
  private transcription: { controller: AbortController } | null = null;
  private prepared: PreparedVoiceTranscription | null = null;
  private interrupted = false;
  /** Status changes before the silent loop first plays are loading noise, not presses. */
  private armed = false;
  private keepAlivePlaying = false;
  /** Set while the runner itself restarts the silent loop, so that change is not a press. */
  private resuming = false;
  private pressTimer: ReturnType<typeof setTimeout> | null = null;
  private evaluateThreads: (() => void) | null = null;
  private starting: Promise<void> | null = null;
  /** Ending in flight; a start waits for it, so it cannot claim a session ending still holds. */
  private stopping: Promise<void> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private listenTimer: ReturnType<typeof setTimeout> | null = null;
  /** Counts the loop's events, so an end the user overtook by pressing is called off. */
  private activity = 0;
  private endingBySelf = false;
  /** When the open segment began, to tell an input that delivers no audio at all. */
  private segmentStartedAt = 0;

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly snapshot = () => this.view;

  private publish(patch: Partial<ConversationView>) {
    this.view = { ...this.view, ...patch };
    for (const listener of this.listeners) listener();
  }

  isRunning(ref?: ScopedThreadRef): boolean {
    if (this.state.phase.kind === "off" || this.ref === null) return false;
    return (
      ref === undefined ||
      (ref.environmentId === this.ref.environmentId && ref.threadId === this.ref.threadId)
    );
  }

  /**
   * Starts in the foreground; throws a message for the user when it cannot. A start already under
   * way is joined, so a double tap cannot claim the audio session twice.
   */
  start(ref: ScopedThreadRef): Promise<void> {
    this.starting ??= this.begin(ref).finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async begin(ref: ScopedThreadRef) {
    if (this.isRunning(ref)) return;
    if (this.isRunning()) await this.stop();
    await this.stopping;
    await loadSpeechSettings();
    const shell = appAtomRegistry.get(environmentThreadShells.threadShellAtom(ref));
    const blocker = conversationBlocker(shell);
    if (blocker) throw new Error(blocker.message);
    const permission = await requestRecordingPermissionsAsync();
    if (!permission.granted) throw new Error("Allow microphone access to talk with the agent.");
    if (!VoiceCapture) throw new Error("Conversations need the latest T3 Code for iPhone.");
    if (audioSessionOwnerKind() === "recording") throw new Error("Finish dictating first.");

    stopSpeech();
    const token = acquireAudioSession("conversation", () => void this.stop());
    this.token = token;
    try {
      if (!(await activateAudioSession(token))) throw new Error("The microphone is in use.");
      // Started here in the foreground: a microphone started in the background records silence.
      await VoiceCapture.start();
    } catch (error) {
      if (this.token === token) this.token = null;
      await releaseAudioSession(token).catch(() => {});
      throw error;
    }

    this.ref = ref;
    this.seen = NO_THREADS_SEEN;
    this.prepared = null;
    this.interrupted = false;
    const title = shell?.title ?? "Thread";
    const request = shell ? handsFreeThreadRequest(shell) : null;
    // A notice another thread was left with, such as its unsent message, stays.
    const notice = this.view.notice && sameRef(this.view.notice.ref, ref) ? null : this.view.notice;
    this.publish({ ref, title, notice, request, interrupted: false, microphoneError: null });
    this.startPlayers(title);
    this.watch(ref);
    const settings = currentSpeechSettings();
    const readMode: SpeechReadMode = canSummarize(ref.environmentId) ? settings.readMode : "full";
    this.dispatch({
      type: "start",
      environmentId: ref.environmentId,
      threadId: ref.threadId,
      readMode,
      agentWorking:
        this.activeSnapshot()?.agentWorking ??
        (shell ? handsFreeThreadFromShell(shell).agentWorking : false),
      // Seeding marks it seen, so it is told here or never.
      ...(request ? { request: { requestId: request.id, kind: request.kind, title } } : {}),
    });
  }

  stop(): Promise<void> {
    if (this.ref === null) return this.stopping ?? Promise.resolve();
    // Everything that can be undone without waiting goes now, the session token included, so a
    // start during the awaits below cannot pick up or lose a token.
    const token = this.token;
    this.token = null;
    this.stopping = this.end(token).finally(() => {
      this.stopping = null;
    });
    return this.stopping;
  }

  private async end(token: ReturnType<typeof acquireAudioSession> | null) {
    // Only what ending leaves behind, such as a message that wasn't sent, outlasts it.
    this.publish({ notice: null, request: null });
    this.dispatch({ type: "stop" });
    this.ref = null;
    if (this.pressTimer) clearTimeout(this.pressTimer);
    this.pressTimer = null;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    this.clearListenTimer();
    for (const release of this.teardown.splice(0)) release();
    this.clip?.controller.abort();
    this.clip = null;
    this.transcription?.controller.abort();
    this.transcription = null;
    const keepAlive = this.keepAlive;
    const voice = this.voice;
    this.keepAlive = null;
    this.voice = null;
    keepAlive?.setActiveForLockScreen(false);
    keepAlive?.release();
    voice?.release();
    await VoiceCapture?.stop().catch(() => {});
    if (token) await releaseAudioSession(token).catch(() => {});
    try {
      new Directory(Paths.cache, AUDIO_DIRECTORY).delete();
    } catch {}
    this.publish({ interrupted: false, microphoneError: null });
  }

  send(event: HandsFreeEvent) {
    this.dispatch(event);
  }

  /** Done, talk or skip from the screen, the lock screen or a headset. */
  press() {
    this.dispatch(handsFreePressEvent(this.state.phase));
  }

  dismissNotice() {
    this.publish({ notice: null });
  }

  private dispatch(event: HandsFreeEvent) {
    const { state, effects } = handsFreeReducer(this.state, event);
    const previous = this.state;
    this.state = state;
    this.publish({ state });
    this.activity += 1;
    if (
      state.phase.kind !== previous.phase.kind ||
      state.agentWorking !== previous.agentWorking ||
      state.held !== previous.held ||
      state.pending.length !== previous.pending.length
    ) {
      this.updateLockScreen();
    }
    this.scheduleIdleEnd();
    for (const effect of effects) this.run(effect);
  }

  /** Any event of the loop or change in its thread starts the count again. */
  private scheduleIdleEnd() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    const ref = this.ref;
    if (!ref || this.state.phase.kind === "off") return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      void this.endBySelf(ref, "idle");
    }, IDLE_END_MS);
  }

  /**
   * Ends without the user asking: the falling tone first, so someone not looking knows play and
   * pause no longer reach T3 Code. A held loop has lost its route, so it ends silently.
   */
  private async endBySelf(ref: ScopedThreadRef, reason: "idle" | "threadGone") {
    if (!this.isRunning(ref) || this.endingBySelf) return;
    this.endingBySelf = true;
    try {
      const voice = this.voice;
      const before = this.activity;
      if (!this.state.held && voice) {
        this.stopAudio();
        voice.replace({ uri: this.endTone });
        voice.setPlaybackRate(1, "high");
        voice.play();
        await new Promise((resolve) =>
          setTimeout(resolve, END_NOTES.length * TONE_SECONDS * 1000 + 200),
        );
        if (!this.isRunning(ref)) return;
        if (reason === "idle" && this.activity !== before) {
          this.scheduleIdleEnd();
          return;
        }
      }
      await this.stop();
    } finally {
      this.endingBySelf = false;
    }
    if (reason === "threadGone") return;
    // A message that wasn't sent matters more; it is kept and told why the conversation ended.
    const left = this.view.notice;
    if (left === null) this.publish({ notice: { text: IDLE_END_NOTICE, ref } });
    else if (sameRef(left.ref, ref)) {
      this.publish({ notice: { text: `${IDLE_END_NOTICE} ${left.text}`, ref } });
    }
  }

  /** The same button means Done or talk, so the lock screen and car display say which. */
  private updateLockScreen() {
    if (!this.keepAlive || this.state.phase.kind === "off") return;
    this.keepAlive.updateLockScreenMetadata({
      title: `Conversation · ${this.view.title}`,
      artist: lockScreenLine(this.state, this.view.request),
    });
  }

  private run(effect: HandsFreeEffect) {
    switch (effect.type) {
      case "speakReply":
        void this.speakReply(effect.id, effect.messageId, effect.mode);
        return;
      case "speak":
        void this.speak(effect.id, effect.text);
        return;
      case "playTone":
        this.playTone(effect.id);
        return;
      case "stopAudio":
        this.stopAudio();
        return;
      case "startRecording": {
        const failed = () =>
          this.dispatch({ type: "recordingFailed", id: effect.id, reopen: !appIsActive() });
        this.segmentStartedAt = Date.now();
        this.clearListenTimer();
        this.listenTimer = setTimeout(() => {
          this.listenTimer = null;
          this.dispatch({ type: "listenTimedOut", id: effect.id });
        }, HANDS_FREE_LISTEN_LIMIT_MS);
        if (VoiceCapture) VoiceCapture.beginSegment().catch(failed);
        else failed();
        return;
      }
      case "finishRecording":
        this.clearListenTimer();
        void this.transcribe(effect.id);
        return;
      case "cancelRecording":
        this.clearListenTimer();
        this.transcription?.controller.abort();
        this.transcription = null;
        void VoiceCapture?.cancelSegment().catch(() => {});
        return;
      case "send":
        void this.deliver(effect);
        return;
      case "notify": {
        const ref = effect.unsent ? unsentRef(effect.unsent) : this.ref;
        if (ref) this.publish({ notice: { text: effect.message, ref } });
        if (effect.unsent) this.keepUnsent(effect.unsent);
        return;
      }
    }
  }

  private clearListenTimer() {
    if (this.listenTimer) clearTimeout(this.listenTimer);
    this.listenTimer = null;
  }

  // Audio

  private startPlayers(title: string) {
    const keepAlive = createAudioPlayer(
      { uri: writeAudio("silence.wav", silentWav()) },
      { keepAudioSessionActive: true },
    );
    keepAlive.loop = true;
    keepAlive.volume = 0;
    this.armed = false;
    this.resuming = false;
    this.keepAlivePlaying = true;
    keepAlive.addListener("playbackStatusUpdate", (status) => {
      if (!this.armed) {
        if (status.playing) this.armed = true;
        this.keepAlivePlaying = status.playing;
        return;
      }
      if (status.playing === this.keepAlivePlaying) return;
      this.keepAlivePlaying = status.playing;
      if (status.playing && this.resuming) {
        this.resuming = false;
        return;
      }
      if (this.interrupted || !this.isRunning() || this.pressTimer) return;
      this.pressTimer = setTimeout(() => this.settlePress(), PRESS_SETTLE_MS);
    });
    keepAlive.play();
    keepAlive.setActiveForLockScreen(true, {
      title: `Conversation · ${title}`,
      artist: lockScreenLine(this.state, this.view.request),
    });
    this.keepAlive = keepAlive;

    const voice = createAudioPlayer(null, { keepAudioSessionActive: true });
    voice.addListener("playbackStatusUpdate", (status) => {
      const clip = this.clip;
      if (!clip || clip.starved) return;
      // A part the player cannot load reports only `error`, so speech or the tone never hangs.
      if (status.error !== null || status.playbackState === "failed") {
        this.playNext(clip);
        return;
      }
      if (!status.didJustFinish) return;
      const expected = clip.durations[clip.next - 1];
      if (expected !== undefined && Math.abs(status.duration - expected) > DURATION_TOLERANCE) {
        return;
      }
      this.playNext(clip);
    });
    this.voice = voice;
    this.tone = writeAudio("tone.wav", toneWav([880]));
    this.endTone = writeAudio("end.wav", toneWav(END_NOTES));
  }

  private tone = "";
  private endTone = "";

  /**
   * A change of the silent loop is a play or pause press on a remote control, unless expo-audio
   * paused it for a call, Siri or a lost route (AirPods out, the car's Bluetooth gone). After a
   * lost route only the loop comes back, for the controls; the reply stays off the speaker.
   */
  private settlePress() {
    this.pressTimer = null;
    if (!this.isRunning() || this.interrupted) return;
    const capture = VoiceCapture?.status();
    if (capture?.interrupted) return;
    this.dispatch(
      capture?.disrupted ? { type: "audioRouteLost" } : handsFreePressEvent(this.state.phase),
    );
    this.resumeKeepAlive();
  }

  private resumeKeepAlive() {
    if (!this.keepAlive || this.keepAlivePlaying) return;
    this.resuming = true;
    this.keepAlive.play();
  }

  private stopAudio() {
    const clip = this.clip;
    this.clip = null;
    if (this.voice) pauseAudioPlayer(this.voice);
    if (clip) this.discardClip(clip);
  }

  private discardClip(clip: Clip) {
    clip.controller.abort();
    for (const uri of clip.parts) if (uri !== this.tone) deleteFile(uri);
  }

  private playTone(id: number) {
    this.stopAudio();
    const clip = this.newClip(id, "tone");
    clip.parts.push(this.tone);
    clip.durations.push(TONE_SECONDS);
    clip.done = true;
    this.playNext(clip);
  }

  private newClip(id: number, kind: Clip["kind"]): Clip {
    const clip: Clip = {
      id,
      kind,
      controller: new AbortController(),
      parts: [],
      durations: [],
      next: 0,
      done: false,
      starved: true,
    };
    this.clip = clip;
    return clip;
  }

  private playNext(clip: Clip) {
    const voice = this.voice;
    if (this.clip !== clip || !voice) return;
    const uri = clip.parts[clip.next];
    if (uri === undefined) {
      clip.starved = true;
      if (clip.done) this.clipEnded(clip);
      return;
    }
    clip.next += 1;
    clip.starved = false;
    voice.replace({ uri });
    voice.setPlaybackRate(
      clip.kind === "speech" ? currentSpeechSettings().playbackRate : 1,
      "high",
    );
    voice.play();
  }

  private clipEnded(clip: Clip) {
    this.clip = null;
    this.discardClip(clip);
    this.dispatch(
      clip.kind === "tone"
        ? { type: "toneEnded", id: clip.id }
        : { type: "speechEnded", id: clip.id },
    );
  }

  private async speakReply(id: number, messageId: string, mode: SpeechReadMode) {
    const ref = this.ref;
    if (!ref) return;
    let text: string | undefined;
    if (mode === "short") {
      try {
        text = (await loadSpokenSummary({ ...ref, messageId: MessageId.make(messageId) })).trim();
      } catch {}
    } else {
      text = appAtomRegistry
        .get(environmentThreadDetails.threadAtom(ref))
        ?.projection.messages.find((message) => message.id === messageId)?.text;
    }
    if (!this.isCurrentSpeech(id)) return;
    if (!text) {
      this.dispatch({ type: "speechFailed", id });
      return;
    }
    await this.speak(id, text);
  }

  private isCurrentSpeech(id: number) {
    const { phase } = this.state;
    return phase.kind === "speaking" && phase.id === id;
  }

  private async speak(id: number, text: string) {
    if (!this.isCurrentSpeech(id)) return;
    this.stopAudio();
    const clip = this.newClip(id, "speech");
    const provider = activeSpeechProvider(currentSpeechSettings());
    try {
      if (!provider || speechProviderProblem(provider)) throw new Error("No voice provider.");
      await synthesizeSpeechParts(provider, planMessageSpeech(text), {
        signal: clip.controller.signal,
        onPart: (piece, index) => {
          if (this.clip !== clip) return;
          clip.parts.push(writeAudio(`speech-${id}-${index}.wav`, encodeWav([piece])));
          clip.durations.push(pcmDuration(piece));
          if (clip.starved) this.playNext(clip);
        },
      });
      clip.done = true;
      if (this.clip === clip && clip.starved) this.clipEnded(clip);
    } catch {
      if (clip.controller.signal.aborted || this.clip !== clip) return;
      // Whatever arrived still plays; a reply that never started is told as failed.
      clip.done = true;
      if (clip.parts.length > 0) {
        if (clip.starved) this.clipEnded(clip);
        return;
      }
      this.clip = null;
      this.dispatch({ type: "speechFailed", id });
    }
  }

  // Microphone

  private async transcribe(id: number) {
    const capture = VoiceCapture;
    if (!capture) return;
    const controller = new AbortController();
    this.transcription = { controller };
    let uri: string | null = null;
    try {
      const segment = await capture.endSegment();
      uri = segment.uri;
      const long = uri !== null && segment.seconds >= MIN_SEGMENT_SECONDS;
      // Restarted in the background, the input may deliver zeros, or nothing at all. A quiet
      // segment while locked is normal, so only the native flag makes quiet mean dead.
      const { suspect } = capture.status();
      const openSeconds = (Date.now() - this.segmentStartedAt) / 1000;
      const empty = (suspect || !appIsActive()) && !long && openSeconds >= 3 * MIN_SEGMENT_SECONDS;
      if (
        empty ||
        (long && (segment.peak < DEAD_SEGMENT_PEAK || (segment.peak < MIN_SEGMENT_PEAK && suspect)))
      ) {
        this.dispatch({ type: "microphoneSilent", id });
        return;
      }
      let text = "";
      if (uri && long && segment.peak >= MIN_SEGMENT_PEAK) {
        this.prepared ??= await this.prepareTranscription(controller.signal);
        text = await this.prepared.transcribe(uri, { signal: controller.signal });
      }
      if (controller.signal.aborted) return;
      this.dispatch({ type: "transcribed", id, text, draftId: uuidv4() });
    } catch {
      this.prepared = null;
      if (!controller.signal.aborted) this.dispatch({ type: "transcriptionFailed", id });
    } finally {
      deleteFile(uri);
      if (this.transcription?.controller === controller) this.transcription = null;
    }
  }

  private prepareTranscription(signal: AbortSignal): Promise<PreparedVoiceTranscription> {
    const ref = this.ref;
    const transcriber = getVoiceTranscriber(
      ref && {
        userMessages: () =>
          appAtomRegistry
            .get(environmentThreadDetails.threadAtom(ref))
            ?.projection.messages.filter((message) => message.role === "user")
            .map((message) => message.text) ?? [],
      },
    );
    if (!transcriber) throw new Error("No dictation is set up.");
    return transcriber.prepare({ signal });
  }

  private onCaptureState(state: VoiceCaptureState) {
    const wasInterrupted = this.interrupted;
    this.interrupted = state.interrupted;
    this.publish({
      interrupted: state.interrupted,
      microphoneError: state.error === undefined ? null : HANDS_FREE_COPY.recordingFailed,
    });
    const { phase } = this.state;
    // Through a call the segment stays open and picks up again after it.
    if (!state.running && !state.interrupted && phase.kind === "listening") {
      this.dispatch({ type: "recordingFailed", id: phase.id, reopen: !appIsActive() });
    }
    if (wasInterrupted && !state.interrupted) {
      // The call paused both players; pick up where they were.
      this.resumeKeepAlive();
      if (this.clip && !this.clip.starved) this.voice?.play();
    }
  }

  // Thread

  private async deliver(effect: Extract<HandsFreeEffect, { type: "send" }>) {
    const ref = {
      environmentId: EnvironmentId.make(effect.environmentId),
      threadId: ThreadId.make(effect.threadId),
    };
    const failed = () => this.dispatch({ type: "sendFailed", id: effect.id });
    const shell = appAtomRegistry.get(environmentThreadShells.threadShellAtom(ref));
    if (!shell || !readEnvironmentScope(ref.environmentId, AuthOrchestrationOperateScope)) {
      failed();
      return;
    }
    // The settings the composer would send with: a model or mode the user picked there wins.
    const serverConfig = appAtomRegistry.get(serverEnvironment.configValueAtom(ref.environmentId));
    const settings = resolveQueuedThreadSettings(
      getComposerDraftSnapshot(scopedThreadKey(ref.environmentId, ref.threadId)),
      shell,
      serverConfig?.providers ?? [],
    );
    if (
      serverConfig &&
      isModelSelectionUnavailable(serverConfig, settings.modelSelection, shell.projectId)
    ) {
      failed();
      return;
    }
    const createdAt = new Date().toISOString();
    const request = handsFreeThreadRequest(shell);
    const mode = dispatchMode(ref, shell);
    if (settings.runtimeMode !== shell.runtimeMode) {
      const synced = await runAtomCommand(
        appAtomRegistry,
        threadEnvironment.setRuntimeMode,
        {
          environmentId: ref.environmentId,
          input: {
            commandId: CommandId.make(`${effect.draftId}:runtime-mode`),
            threadId: ref.threadId,
            runtimeMode: settings.runtimeMode,
            createdAt,
          },
        },
        { reportFailure: false },
      );
      if (synced._tag !== "Success") {
        failed();
        return;
      }
    }
    if (settings.interactionMode !== shell.interactionMode) {
      const synced = await runAtomCommand(
        appAtomRegistry,
        threadEnvironment.setInteractionMode,
        {
          environmentId: ref.environmentId,
          input: {
            commandId: CommandId.make(`${effect.draftId}:interaction-mode`),
            threadId: ref.threadId,
            interactionMode: settings.interactionMode,
            createdAt,
          },
        },
        { reportFailure: false },
      );
      if (synced._tag !== "Success") {
        failed();
        return;
      }
    }
    const result = await runAtomCommand(
      appAtomRegistry,
      threadEnvironment.startTurn,
      {
        environmentId: ref.environmentId,
        input: {
          // The draft id is the command id, so the receipt drops a resend the server already ran.
          commandId: CommandId.make(effect.draftId),
          creationSource: "mobile",
          threadId: ref.threadId,
          message: {
            messageId: MessageId.make(effect.draftId),
            role: "user",
            text: effect.text,
            attachments: [],
          },
          modelSelection: settings.modelSelection,
          titleSeed: deriveThreadTitleSeed({ text: effect.text, attachments: [] }),
          runtimeMode: settings.runtimeMode,
          interactionMode: settings.interactionMode,
          createdAt,
          ...(mode === null ? {} : { dispatchMode: mode }),
        },
      },
      { reportFailure: false },
    );
    if (result._tag !== "Success") {
      failed();
      return;
    }
    // Deliver a turn that already finished first, so its reply is not waited for again.
    this.evaluateThreads?.();
    const runs = appAtomRegistry.get(environmentThreadDetails.quietThreadAtom(ref))?.projection
      .runs;
    this.dispatch({
      type: "sent",
      id: effect.id,
      agentWorking: handsFreeWorkingAfterSend(runs ?? [], effect.draftId),
      ...(request ? { queuedBehind: request.kind } : {}),
    });
  }

  /** A message the conversation could not send stays in its thread's composer, not just a notice. */
  private keepUnsent(unsent: HandsFreeUnsent) {
    const ref = unsentRef(unsent);
    void mergeComposerDraftContent(scopedThreadKey(ref.environmentId, ref.threadId), {
      text: unsent.text,
      attachments: [],
    }).catch(() => {});
  }

  private activeSnapshot(): HandsFreeThreadSnapshot | null {
    const ref = this.ref;
    if (!ref) return null;
    const thread = appAtomRegistry.get(environmentThreadDetails.quietThreadAtom(ref));
    if (!thread) return null;
    const shell = appAtomRegistry.get(environmentThreadShells.threadShellAtom(ref));
    return handsFreeThreadFromDetail({
      environmentId: ref.environmentId,
      threadId: ref.threadId,
      title: shell?.title ?? thread.projection.thread.title,
      request: shell ? handsFreeThreadRequest(shell) : null,
      runs: thread.projection.runs,
      messages: thread.projection.messages,
    });
  }

  private watch(ref: ScopedThreadRef) {
    const registry = appAtomRegistry;
    const shellsAtom = environmentThreadShells.quietThreadShellsAtom;
    const detailAtom = environmentThreadDetails.quietThreadAtom(ref);
    const evaluate = (seedOnly: boolean) => {
      if (!this.isRunning(ref) && !seedOnly) return;
      const snapshots: HandsFreeThreadSnapshot[] = [];
      for (const shell of registry.get(shellsAtom)) {
        if (isActive(shell, ref) || !announces(shell)) continue;
        snapshots.push(handsFreeThreadFromShell(shell));
      }
      // The active thread waits for its detail: its shell knows only the run under way.
      const active = this.activeSnapshot();
      if (active) snapshots.push(active);
      if (!seedOnly && threadGone(ref)) {
        // Its screen and bar are gone with it, so nothing else could end the conversation.
        void this.endBySelf(ref, "threadGone");
        return;
      }
      const activeShell = registry.get(environmentThreadShells.threadShellAtom(ref));
      const request = activeShell ? handsFreeThreadRequest(activeShell) : null;
      if (request?.id !== this.view.request?.id) {
        this.publish({ request });
        this.updateLockScreen();
        this.scheduleIdleEnd();
      }
      if (seedOnly && !active && activeShell) {
        this.seen = handsFreeSeedThreadFromShell(this.seen, activeShell);
      }
      const { seen, events } = handsFreeThreadEvents(this.seen, snapshots);
      this.seen = seen;
      if (seedOnly) return;
      for (const event of events) this.dispatch(event);
      // A queued run removed or held elsewhere ends the work without any turn finishing.
      if (active && this.isRunning(ref) && active.agentWorking !== this.state.agentWorking) {
        this.dispatch({ type: "agentWorkingChanged", agentWorking: active.agentWorking });
      }
    };
    this.evaluateThreads = () => evaluate(false);
    this.teardown.push(
      () => {
        this.evaluateThreads = null;
      },
      registry.mount(environmentThreads.stateAtom(ref.environmentId, ref.threadId)),
      registry.subscribe(shellsAtom, () => evaluate(false)),
      registry.subscribe(detailAtom, () => {
        if (this.isRunning(ref)) this.scheduleIdleEnd();
        evaluate(false);
      }),
    );
    const subscription = VoiceCapture?.addListener("onStateChange", (state) =>
      this.onCaptureState(state),
    );
    if (subscription) this.teardown.push(() => subscription.remove());
    // Only the foreground can restart a microphone that a background restart left silent.
    const appState = AppState.addEventListener("change", (next) => {
      if (next === "active") void VoiceCapture?.recover().catch(() => {});
    });
    this.teardown.push(() => appState.remove());
    evaluate(true);
  }
}

/**
 * Like the composer: queued while a run is still being set up, else the user's follow-up choice
 * while a turn runs, else null for the server's own delivery. Read from the thread now, not the
 * loop's cached state. A message while the thread waits on an approval or question queues behind
 * it; voice never answers one.
 */
function dispatchMode(ref: ScopedThreadRef, shell: EnvironmentThreadShell) {
  if (handsFreeThreadRequest(shell)) return "queue" as const;
  const thread = appAtomRegistry.get(environmentThreadDetails.threadAtom(ref));
  const runtime = thread ? deriveThreadRuntime(thread.projection) : shell.runtime;
  const activityRun = thread ? deriveThreadActivityRun(thread.projection) : shell.latestRun;
  const preferences = appAtomRegistry.get(mobilePreferencesAtom);
  const mode = resolveFollowUpDispatchMode({
    running: threadRuntimeIsActive(runtime),
    canSteer:
      appAtomRegistry.get(environmentThreadDetails.queueWorkflowAtom(ref))?.canPromoteToSteer ===
      true,
    setupRunning: [activityRun?.status, runtime?.status].some(
      (status) => status === "preparing" || status === "starting",
    ),
    activeTurnDefault: AsyncResult.isSuccess(preferences)
      ? (preferences.value.followUpBehavior ?? DEFAULT_FOLLOW_UP_BEHAVIOR)
      : DEFAULT_FOLLOW_UP_BEHAVIOR,
  });
  return mode;
}

const appIsActive = () => AppState.currentState === "active";

/**
 * Archived or deleted, read from its detail: the list drops such a thread from its shells, so
 * the shell cannot say.
 */
function threadGone(ref: ScopedThreadRef) {
  const state = appAtomRegistry.get(environmentThreadDetails.stateAtom(ref));
  const thread = Option.getOrNull(state.data)?.thread;
  return (
    state.status === "deleted" ||
    (thread !== undefined && (thread.archivedAt !== null || thread.deletedAt !== null))
  );
}

const sameRef = (a: ScopedThreadRef, b: ScopedThreadRef) =>
  a.environmentId === b.environmentId && a.threadId === b.threadId;

const unsentRef = (unsent: HandsFreeUnsent): ScopedThreadRef => ({
  environmentId: EnvironmentId.make(unsent.environmentId),
  threadId: ThreadId.make(unsent.threadId),
});

function lockScreenLine(state: HandsFreeState, request: HandsFreeThreadRequest | null): string {
  switch (state.phase.kind) {
    case "listening":
    case "tone":
      return "Listening. Press to send";
    case "speaking":
      return state.phase.then === "unsent"
        ? "Not sent. Press to send again"
        : "Reading. Press to talk";
    case "transcribing":
      return "Transcribing";
    case "sending":
      return "Sending";
    case "unsent":
      return "Not sent. Press to send again";
    case "waiting":
      if (state.held) {
        return state.pending.length > 0
          ? "Reply waiting. Press to hear it"
          : "Paused. Press to talk";
      }
      if (request) {
        return request.kind === "approval"
          ? "Approval needed on screen. Press to talk"
          : "Question on screen. Press to talk";
      }
      return state.agentWorking ? "Agent working. Press to talk" : "Press to talk";
    case "off":
      return "T3 Code";
  }
}

function isActive(shell: EnvironmentThreadShell, ref: ScopedThreadRef) {
  return shell.environmentId === ref.environmentId && shell.id === ref.threadId;
}

/** Top-level threads the user works with; subagents report to their parent instead. */
function announces(shell: EnvironmentThreadShell) {
  return shell.archivedAt === null && shell.lineage.relationshipToParent !== "subagent";
}

export const conversation = new Conversation();

export function useConversation(): ConversationView {
  return useSyncExternalStore(conversation.subscribe, conversation.snapshot);
}

/** Whether the conversation with this thread runs; re-renders only when that changes. */
export function useConversationRunning(ref: ScopedThreadRef | null): boolean {
  return useSyncExternalStore(conversation.subscribe, () =>
    ref === null ? false : conversation.isRunning(ref),
  );
}
