import {
  activeSpeechProvider,
  decideSpeak,
  type SpeechProviderConfig,
  encodeWav,
  locateSpeechTime,
  resolveSpokenText,
  type SpeechReadMode,
  type SpokenText,
  pcmDuration,
  planMessageSpeech,
  requestedReadMode,
  speechCacheKeySource,
  speechPartStart,
  speechProviderProblem,
  speechTimelineDuration,
  synthesizeSpeechParts,
} from "@t3tools/client-runtime/speech";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useSyncExternalStore } from "react";

import { loadSpeechSettings } from "./speechSettings";

export const SPEECH_SKIP_SECONDS = 15;
const CACHE_LIMIT = 12;

export type SpeechPhase = "idle" | "preparing" | "playing" | "paused";

export interface SpeechPlaybackState {
  readonly messageId: string | null;
  /** What is read: the spoken summary or the whole reply. */
  readonly mode: SpeechReadMode;
  /** The message has a server thread, so it can switch to its short version. */
  readonly shortAvailable: boolean;
  /** A short version just finished; the player offers the full reply. */
  readonly fullOffer: boolean;
  /** The server is writing the short version, which can take far longer than synthesis. */
  readonly writingShort: boolean;
  readonly phase: SpeechPhase;
  /** Seconds into the whole message. */
  readonly currentTime: number;
  /** Length of the audio synthesized so far; it grows while later parts arrive. */
  readonly duration: number;
  /** Playback reached a part that is still being synthesized. */
  readonly buffering: boolean;
}

export class SpeechNotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SpeechNotConfiguredError";
  }
}

interface SpeechPart {
  readonly url: string;
  readonly duration: number;
}

export interface SpeechRequest {
  readonly messageId: string;
  readonly markdown: string;
  readonly title: string;
  /** Defaults to the full reply. */
  readonly mode?: SpeechReadMode;
  /** The server thread the reply belongs to, so a player can tell which thread it reads. */
  readonly threadRef?: ScopedThreadRef;
  /** Writes the short version; absent for replies without a server thread. */
  readonly loadSummary?: () => Promise<string>;
  /**
   * The short version could not be written, so the full reply plays instead. `chosen` is set when
   * the reader switched this playback to Short, so the failure answers their own request.
   */
  readonly onShortUnavailable?: (error: unknown, chosen: boolean) => void;
  /** Plays with this provider instead of the one chosen for read aloud, e.g. a voice sample. */
  readonly provider?: SpeechProviderConfig;
}

/** One message being read: a playlist of parts that grows while they are synthesized. */
interface Session {
  readonly messageId: string;
  readonly controller: AbortController;
  readonly parts: SpeechPart[];
  /** Part URLs this session created; a cached whole message belongs to the cache instead. */
  ownsUrls: boolean;
  /** No more parts will arrive. */
  done: boolean;
  /** The part in the audio element, or the one playback waits for. */
  index: number;
  waiting: boolean;
  /** Whether to play once the awaited part arrives. */
  resume: boolean;
}

const IDLE: SpeechPlaybackState = {
  messageId: null,
  mode: "full",
  shortAvailable: false,
  fullOffer: false,
  writingShort: false,
  phase: "idle",
  currentTime: 0,
  duration: 0,
  buffering: false,
};

let state = IDLE;
let audio: HTMLAudioElement | null = null;
let session: Session | null = null;
let lastRequest: SpeechRequest | null = null;
// A switch to Short while the full reply keeps playing; cleared to cancel it.
let pendingShort: object | null = null;
let playbackRate = 1;
// Recently spoken messages as one WAV each, so replaying one does not call the provider again.
const cache = new Map<string, SpeechPart>();
const listeners = new Set<() => void>();

function setState(next: SpeechPlaybackState) {
  state = next;
  for (const listener of listeners) listener();
}

function durations(current: Session): number[] {
  return current.parts.map((part) => part.duration);
}

function sync() {
  const current = session;
  // A part that just ended fires `pause` before `ended`; the next part takes over from there.
  if (!audio || !current || current.waiting || audio.ended || state.phase === "preparing") return;
  const known = durations(current);
  setState({
    ...state,
    phase: audio.paused ? "paused" : "playing",
    currentTime: speechPartStart(known, current.index) + audio.currentTime,
    duration: speechTimelineDuration(known),
    buffering: false,
  });
  updatePositionState();
}

function updatePositionState() {
  if (!("mediaSession" in navigator) || state.duration <= 0) return;
  try {
    navigator.mediaSession.setPositionState({
      duration: state.duration,
      playbackRate,
      position: Math.min(state.currentTime, state.duration),
    });
  } catch {}
}

function ensureAudio(): HTMLAudioElement {
  if (!audio) {
    audio = new Audio();
    for (const event of ["play", "pause", "timeupdate", "durationchange", "seeked"]) {
      audio.addEventListener(event, sync);
    }
    audio.addEventListener("ended", () => {
      if (session) goTo(speechPartStart(durations(session), session.index + 1), true);
    });
  }
  return audio;
}

function loadPart(current: Session, index: number, offset: number, play: boolean) {
  const element = ensureAudio();
  current.index = index;
  current.waiting = false;
  element.src = current.parts[index]!.url;
  // Loading a source resets the rate to the default one.
  element.defaultPlaybackRate = playbackRate;
  element.playbackRate = playbackRate;
  if (offset > 0) element.currentTime = offset;
  if (play) element.play().catch(() => {});
}

/** Moves playback to a position on the whole message's timeline. */
function goTo(time: number, play: boolean) {
  const current = session;
  if (!current) return;
  const known = durations(current);
  const { index, offset } = locateSpeechTime(known, time);
  if (index < current.parts.length) {
    if (index === current.index && !current.waiting && audio) {
      audio.currentTime = offset;
      if (play && audio.paused) audio.play().catch(() => {});
    } else {
      loadPart(current, index, offset, play);
    }
    return;
  }
  if (current.done) {
    finishSpeech();
    return;
  }
  // Past the synthesized audio: wait for the next part, which plays from its start.
  current.index = index;
  current.waiting = true;
  current.resume = play;
  audio?.pause();
  setState({
    ...state,
    phase: play ? "playing" : "paused",
    currentTime: speechTimelineDuration(known),
    duration: speechTimelineDuration(known),
    buffering: true,
  });
}

function onPartReady(current: Session) {
  if (state.phase === "preparing") {
    setState({ ...state, phase: current.resume ? "playing" : "paused" });
    loadPart(current, 0, 0, current.resume);
  } else if (current.waiting && current.index === current.parts.length - 1) {
    loadPart(current, current.index, 0, current.resume);
  } else {
    setState({ ...state, duration: speechTimelineDuration(durations(current)) });
    updatePositionState();
  }
}

/** Media keys, the macOS Now Playing widget, and headphones control the message being read. */
function claimMediaSession(title: string) {
  if (!("mediaSession" in navigator)) return;
  const mediaSession = navigator.mediaSession;
  mediaSession.metadata = new MediaMetadata({ title: title || "T3 Code", artist: "T3 Code" });
  mediaSession.setActionHandler("play", () => {
    if (session?.waiting) session.resume = true;
    else void audio?.play();
  });
  mediaSession.setActionHandler("pause", () => {
    if (session?.waiting) session.resume = false;
    else audio?.pause();
  });
  mediaSession.setActionHandler("stop", stopSpeech);
  mediaSession.setActionHandler("seekbackward", (details) =>
    seekSpeech(-(details.seekOffset ?? SPEECH_SKIP_SECONDS)),
  );
  mediaSession.setActionHandler("seekforward", (details) =>
    seekSpeech(details.seekOffset ?? SPEECH_SKIP_SECONDS),
  );
  mediaSession.setActionHandler("seekto", (details) => {
    if (details.seekTime !== undefined) seekTo(details.seekTime);
  });
}

function releaseMediaSession() {
  if (!("mediaSession" in navigator)) return;
  const mediaSession = navigator.mediaSession;
  mediaSession.metadata = null;
  for (const action of [
    "play",
    "pause",
    "stop",
    "seekbackward",
    "seekforward",
    "seekto",
  ] as const) {
    mediaSession.setActionHandler(action, null);
  }
}

function remember(key: string, part: SpeechPart) {
  cache.set(key, part);
  while (cache.size > CACHE_LIMIT) {
    const [oldest, oldestPart] = cache.entries().next().value!;
    cache.delete(oldest);
    URL.revokeObjectURL(oldestPart.url);
  }
}

function wavUrl(wav: Uint8Array): string {
  return URL.createObjectURL(new Blob([wav as Uint8Array<ArrayBuffer>], { type: "audio/wav" }));
}

/**
 * Starts reading a message, or toggles pause when it already plays in that mode. Playback starts
 * with the first part while later parts are synthesized one request at a time; the promise settles
 * once every part is ready.
 */
export async function speakMessage(input: SpeechRequest): Promise<void> {
  const requestedMode = requestedReadMode(input.mode, Boolean(input.loadSummary));
  const loaded = state.phase !== "idle" && state.messageId === input.messageId;
  switch (
    decideSpeak({
      loaded,
      preparing: state.phase === "preparing",
      switchingToShort: pendingShort !== null,
      currentMode: state.mode,
      requestedMode,
    })
  ) {
    case "cancelShortSwitch":
      pendingShort = null;
      setState({ ...state, writingShort: false });
      return;
    case "ignore":
      return;
    case "togglePause":
      toggleSpeechPause();
      return;
    case "switchToShort":
      return switchToShort(input);
    case "start":
      return startReading(input, requestedMode, null, loaded);
  }
}

/** Keeps the full reply playing until the short version is ready, so a failure loses nothing. */
async function switchToShort(input: SpeechRequest): Promise<void> {
  const token = {};
  pendingShort = token;
  setState({ ...state, writingShort: true });
  const spoken = await resolveSpokenText({
    mode: "short",
    fullText: input.markdown,
    loadSummary: input.loadSummary ?? null,
  });
  if (pendingShort !== token) return;
  pendingShort = null;
  if (spoken.shortUnavailable === undefined) {
    // A reader who paused while it was written gets the short version paused, not out loud.
    const paused = state.phase === "paused" || (session?.waiting === true && !session.resume);
    return startReading(input, "short", spoken, true, !paused);
  }
  setState({ ...state, writingShort: false, shortAvailable: false });
  input.onShortUnavailable?.(spoken.shortUnavailable, true);
}

async function startReading(
  input: SpeechRequest,
  requestedMode: SpeechReadMode,
  resolved: SpokenText | null,
  chosen: boolean,
  play = true,
): Promise<void> {
  stopSpeech();
  const settings = await loadSpeechSettings();
  const provider = input.provider ?? activeSpeechProvider(settings);
  if (!provider) throw new SpeechNotConfiguredError("Add a voice provider to read messages aloud.");
  const problem = speechProviderProblem(provider);
  if (problem)
    throw new SpeechNotConfiguredError(`${provider.name || "Voice provider"}: ${problem}`);
  // Another message may have started while settings loaded.
  stopSpeech();

  playbackRate = settings.playbackRate;
  const current: Session = {
    messageId: input.messageId,
    controller: new AbortController(),
    parts: [],
    ownsUrls: true,
    done: false,
    index: 0,
    waiting: false,
    resume: play,
  };
  session = current;
  lastRequest = input;
  setState({
    ...IDLE,
    messageId: input.messageId,
    mode: requestedMode,
    shortAvailable: Boolean(input.loadSummary),
    writingShort: resolved === null && requestedMode === "short",
    phase: "preparing",
  });
  claimMediaSession(input.title);

  const spoken =
    resolved ??
    (await resolveSpokenText({
      mode: requestedMode,
      fullText: input.markdown,
      loadSummary: input.loadSummary ?? null,
    }));
  if (session !== current) return;
  if (state.writingShort) setState({ ...state, writingShort: false });
  if (spoken.shortUnavailable !== undefined) {
    // Offering Short again would only repeat the failed request.
    setState({ ...state, mode: "full", shortAvailable: false });
    input.onShortUnavailable?.(spoken.shortUnavailable, chosen);
  }

  const key = `${spoken.mode}:${speechCacheKeySource(provider, spoken.text)}`;
  const cached = cache.get(key);
  if (cached) {
    current.parts.push(cached);
    current.ownsUrls = false;
    current.done = true;
    onPartReady(current);
    return;
  }

  try {
    const pieces = await synthesizeSpeechParts(provider, planMessageSpeech(spoken.text), {
      signal: current.controller.signal,
      onPart: (piece) => {
        if (session !== current) return;
        current.parts.push({ url: wavUrl(encodeWav([piece])), duration: pcmDuration(piece) });
        onPartReady(current);
      },
    });
    if (session !== current) return;
    current.done = true;
    remember(key, {
      url: wavUrl(encodeWav(pieces)),
      duration: speechTimelineDuration(durations(current)),
    });
    if (current.waiting) finishSpeech();
  } catch (error) {
    if (session !== current || current.controller.signal.aborted) return;
    // Keep playing what arrived; the message ends early.
    current.done = true;
    if (current.parts.length === 0 || current.waiting) stopSpeech();
    throw error;
  }
}

function seekTo(time: number) {
  if (!session || state.phase === "preparing") return;
  goTo(Math.max(0, time), session.waiting ? session.resume : audio ? !audio.paused : false);
}

export function toggleSpeechPause() {
  if (state.buffering) return;
  if (state.phase === "playing") audio?.pause();
  else if (state.phase === "paused") void audio?.play();
}

export function seekSpeech(deltaSeconds: number) {
  seekTo(state.currentTime + deltaSeconds);
}

export function setSpeechPlaybackRate(rate: number) {
  playbackRate = rate;
  if (audio) {
    audio.defaultPlaybackRate = rate;
    audio.playbackRate = rate;
  }
}

/** The request being read or last read, so a player can replay it in the other mode. */
export function currentSpeechRequest(): SpeechRequest | null {
  return lastRequest;
}

/** Ends playback at the end of the audio; a short version then offers the full reply. */
function finishSpeech() {
  const ended = state;
  stopSpeech();
  if (ended.mode !== "short") return;
  setState({
    ...IDLE,
    messageId: ended.messageId,
    mode: "short",
    shortAvailable: true,
    fullOffer: true,
  });
}

export function stopSpeech() {
  const current = session;
  if (!current) {
    if (state.fullOffer) setState(IDLE);
    return;
  }
  session = null;
  pendingShort = null;
  current.controller.abort();
  setState(IDLE);
  if (audio) {
    audio.pause();
    audio.removeAttribute("src");
    audio.load();
  }
  if (current.ownsUrls) {
    for (const part of current.parts) URL.revokeObjectURL(part.url);
  }
  releaseMediaSession();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function currentSpeechPhase(): SpeechPhase {
  return state.phase;
}

/** Re-renders on every playback change, whichever message is being read. */
export function useSpeechPlaybackState(): SpeechPlaybackState {
  return useSyncExternalStore(subscribe, () => state);
}

/** Re-renders only for the message being read, so other rows stay still while audio plays. */
export function useSpeechPlayback(messageId: string): SpeechPlaybackState {
  return useSyncExternalStore(subscribe, () => (state.messageId === messageId ? state : IDLE));
}
