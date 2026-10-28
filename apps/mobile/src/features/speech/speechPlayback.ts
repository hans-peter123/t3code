import { CryptoDigestAlgorithm, digestStringAsync } from "expo-crypto";
import {
  type AudioPlayer,
  type AudioStatus,
  createAudioPlayer,
  setIsAudioActiveAsync,
} from "expo-audio";
import { Directory, File, Paths } from "expo-file-system";
import { useSyncExternalStore } from "react";

import {
  decideSpeak,
  encodeWav,
  locateSpeechTime,
  pcmDuration,
  planMessageSpeech,
  requestedReadMode,
  resolveSpokenText,
  silentWav,
  speechCacheKeySource,
  speechPartStart,
  speechTimelineDuration,
  type SpeechReadMode,
  type SpokenText,
  synthesizeSpeechParts,
} from "@t3tools/client-runtime/speech";
import {
  acquireAudioSession,
  activateAudioSession,
  conversationHoldsAudioSession,
  isAudioSessionOwner,
  releaseAudioSession,
} from "../../lib/audioSession";
import {
  activeSpeechProvider,
  loadSpeechSettings,
  speechProviderProblem,
  type SpeechProviderConfig,
} from "./speechSettings";

export const SPEECH_SKIP_SECONDS = 15;
const CACHE_DIRECTORY = "speech";
const PARTS_DIRECTORY = "speech-parts";
const CACHE_LIMIT = 24;
/** The player's item duration matches ours within this, which tells its status apart. */
const DURATION_TOLERANCE = 0.1;

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
  /**
   * The short version could not be written and the reader should be told. While idle, the full
   * reply had already ended, so nothing reads it and the next press reads it in full.
   */
  readonly shortUnavailable: boolean;
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

export interface SpeechRequest {
  readonly messageId: string;
  readonly markdown: string;
  readonly title: string;
  /** Defaults to the full reply. */
  readonly mode?: SpeechReadMode;
  /** Writes the short version; absent for replies without a server thread. */
  readonly loadSummary?: () => Promise<string>;
  /**
   * The short version could not be written. `chosen` is set when the reader switched this playback
   * to Short; `readingFull` is false when the full reply had already ended. Returns whether to tell
   * the reader.
   */
  readonly onShortUnavailable?: (error: unknown, chosen: boolean, readingFull: boolean) => boolean;
  /** Plays with this provider instead of the one chosen for read aloud, e.g. a voice sample. */
  readonly provider?: SpeechProviderConfig;
}

/** The player holds the whole message's WAV rather than one part. */
const WHOLE = -1;

interface SpeechFile {
  readonly uri: string;
  /** `null` for a cached file, whose length the player reports. */
  readonly duration: number | null;
}

/**
 * One message being read. While parts are synthesized it plays them as a playlist; once all are
 * ready the joined WAV is cached and playback moves to it at the next part boundary, so the lock
 * screen's scrubber and 15 second skips cover the whole message.
 */
interface Session {
  readonly messageId: string;
  readonly controller: AbortController;
  readonly parts: SpeechFile[];
  partsDirectory: Directory | null;
  whole: SpeechFile | null;
  /** No more parts will arrive. */
  done: boolean;
  /** The part in the player, `WHOLE`, or the part playback waits for. */
  item: number;
  waiting: boolean;
  /** Whether to play once the awaited part arrives. */
  resume: boolean;
  /** Applied once the player has loaded the new item; seeking earlier is dropped. */
  pendingSeek: { readonly offset: number; readonly play: boolean } | null;
}

const IDLE: SpeechPlaybackState = {
  messageId: null,
  mode: "full",
  shortAvailable: false,
  fullOffer: false,
  writingShort: false,
  shortUnavailable: false,
  phase: "idle",
  currentTime: 0,
  duration: 0,
  buffering: false,
};

let state = IDLE;
let player: AudioPlayer | null = null;
let session: Session | null = null;
/**
 * The short version the reader switched to. The full reply keeps the player, its pauses and its
 * parts until this session's first part is ready; cleared to cancel the switch.
 */
let pendingShort: Session | null = null;
/**
 * Silence holding the session while nothing else plays. The lock screen can pause it, which the
 * first part honours; `started` ignores the statuses a player reports while it loads.
 */
let hold: { started: boolean; paused: boolean } | null = null;
// Held from the first press until playback stops, so a recording or other player cancels it.
let audioToken: ReturnType<typeof acquireAudioSession> | null = null;
let playbackRate = 1;
const listeners = new Set<() => void>();

function setState(next: SpeechPlaybackState) {
  state = next;
  for (const listener of listeners) listener();
}

function partDurations(current: Session): number[] {
  return current.parts.map((part) => part.duration ?? 0);
}

function itemDuration(current: Session): number | null {
  return current.item === WHOLE
    ? (current.whole?.duration ?? null)
    : current.parts[current.item]!.duration;
}

function onStatus(status: AudioStatus) {
  if (hold && state.phase === "preparing") {
    if (status.playing) hold = { started: true, paused: false };
    else if (hold.started) hold.paused = true;
    return;
  }
  const current = session;
  if (!current || current.waiting || state.phase === "preparing") return;
  // Right after a switch the player can still report the previous item; ours has a known length.
  const expected = itemDuration(current);
  if (
    expected !== null &&
    (!status.isLoaded || Math.abs(status.duration - expected) > DURATION_TOLERANCE)
  ) {
    return;
  }
  if (current.pendingSeek) {
    const { offset, play } = current.pendingSeek;
    const item = current.item;
    current.pendingSeek = null;
    void player?.seekTo(offset).then(() => {
      if (play && session === current && current.item === item) player?.play();
    });
    return;
  }
  if (status.didJustFinish) {
    if (current.item === WHOLE) finishSpeech();
    else goTo(speechPartStart(partDurations(current), current.item + 1), true);
    return;
  }
  const known = partDurations(current);
  setState({
    ...state,
    phase: status.playing ? "playing" : "paused",
    currentTime:
      (current.item === WHOLE ? 0 : speechPartStart(known, current.item)) + status.currentTime,
    duration:
      current.item === WHOLE ? status.duration || state.duration : speechTimelineDuration(known),
    buffering: false,
  });
}

function ensurePlayer(): AudioPlayer {
  if (!player) {
    // Keeps the audio session between parts, so the next one can start in the background.
    player = createAudioPlayer(null, { updateInterval: 250, keepAudioSessionActive: true });
    player.addListener("playbackStatusUpdate", onStatus);
  }
  return player;
}

function load(current: Session, item: number, offset: number, play: boolean) {
  const audio = ensurePlayer();
  hold = null;
  current.item = item;
  current.waiting = false;
  current.pendingSeek = offset > 0 ? { offset, play } : null;
  // Paused first, so the player does not start the new item by itself before the seek.
  audio.pause();
  audio.loop = false;
  audio.replace({ uri: (item === WHOLE ? current.whole : current.parts[item])!.uri });
  audio.setPlaybackRate(playbackRate, "high");
  if (play && !current.pendingSeek) audio.play();
}

/** Moves playback to a position on the whole message's timeline. */
function goTo(time: number, play: boolean) {
  const current = session;
  if (!current) return;
  const target = Math.max(0, time);
  if (current.whole) {
    if (current.item === WHOLE && !current.pendingSeek) {
      void player?.seekTo(Math.min(target, state.duration || target));
      if (play) player?.play();
    } else {
      load(current, WHOLE, target, play);
    }
    return;
  }
  const known = partDurations(current);
  const { index, offset } = locateSpeechTime(known, target);
  if (index < current.parts.length) {
    if (index === current.item && !current.waiting && !current.pendingSeek) {
      void player?.seekTo(offset);
      if (play) player?.play();
    } else {
      load(current, index, offset, play);
    }
    return;
  }
  if (current.done) {
    finishSpeech();
    return;
  }
  // Past the synthesized audio: wait for the next part, which plays from its start.
  current.item = index;
  current.waiting = true;
  current.resume = play;
  current.pendingSeek = null;
  player?.pause();
  const duration = speechTimelineDuration(known);
  setState({
    ...state,
    phase: play ? "playing" : "paused",
    currentTime: duration,
    duration,
    buffering: true,
  });
}

function onPartReady(current: Session, title: string) {
  if (state.phase === "preparing") {
    if (hold?.paused) current.resume = false;
    setState({ ...state, phase: current.resume ? "playing" : "paused" });
    load(current, current.whole ? WHOLE : 0, 0, current.resume);
    ensurePlayer().setActiveForLockScreen(
      true,
      { title: title || "T3 Code", artist: "T3 Code" },
      { showSeekBackward: true, showSeekForward: true },
    );
  } else if (current.waiting && current.item === current.parts.length - 1) {
    load(current, current.item, 0, current.resume);
  } else {
    setState({ ...state, duration: speechTimelineDuration(partDurations(current)) });
  }
}

function cacheFile(key: string) {
  const directory = new Directory(Paths.cache, CACHE_DIRECTORY);
  directory.create({ idempotent: true, intermediates: true });
  return { directory, file: new File(directory, `${key}.wav`) };
}

async function writeCachedWav(key: string, wav: Uint8Array): Promise<string> {
  const { directory, file } = cacheFile(key);
  const cached = directory.list().filter((entry) => entry instanceof File);
  if (cached.length >= CACHE_LIMIT) {
    for (const entry of cached) entry.delete();
  }
  await file.write(wav);
  return file.uri;
}

/**
 * Plays silence until the first part is ready. A locked iPhone suspends an app that plays nothing,
 * which would stop a short version or the first part from ever arriving.
 */
async function holdSession() {
  // Checked each time: a full audio cache is cleared, silence included.
  const { file } = cacheFile("silence");
  if (!file.exists) await file.write(silentWav());
  // The first part leaves "preparing" before it loads, so this cannot replace it.
  if (state.phase !== "preparing") return;
  const audio = ensurePlayer();
  hold = { started: false, paused: false };
  audio.replace({ uri: file.uri });
  audio.loop = true;
  audio.play();
}

/**
 * Takes the shared audio session for playback in the background; false when it was lost while
 * activating. Throws while a recording owns it, which read aloud must not play over.
 */
async function claimAudioSession(): Promise<boolean> {
  if (audioToken && isAudioSessionOwner(audioToken)) return true;
  const token = acquireAudioSession(
    "playback",
    () => stopSpeech(),
    () => void setIsAudioActiveAsync(false).catch(() => {}),
  );
  if (!isAudioSessionOwner(token)) {
    throw new Error(
      conversationHoldsAudioSession()
        ? "End the conversation to read aloud."
        : "Finish dictating to read aloud.",
    );
  }
  audioToken = token;
  return activateAudioSession(token, false, true);
}

/** A fresh directory for one message's part files; leftovers go first, except `keep`, still playing. */
function createPartsDirectory(messageKey: string, keep: Directory | null): Directory {
  const root = new Directory(Paths.cache, PARTS_DIRECTORY);
  if (root.exists) {
    for (const entry of root.list()) if (entry.uri !== keep?.uri) entry.delete();
  }
  const directory = new Directory(root, messageKey);
  directory.create({ idempotent: true, intermediates: true });
  return directory;
}

/**
 * Starts reading a message, or toggles pause when it already plays in that mode. Playback starts
 * with the first part while later parts are synthesized one request at a time; the promise settles
 * once every part is ready.
 */
export async function speakMessage(input: SpeechRequest): Promise<void> {
  const knownUnavailable =
    state.phase === "idle" && state.messageId === input.messageId && state.shortUnavailable;
  const requestedMode = knownUnavailable
    ? "full"
    : requestedReadMode(input.mode, Boolean(input.loadSummary));
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
      // With the full reply already over, nothing is left to play.
      if (!session) return stopSpeech();
      cancelShortSwitch();
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
      return startReading(input, requestedMode, loaded, knownUnavailable);
  }
}

function shortUnavailable(
  input: SpeechRequest,
  error: unknown,
  chosen: boolean,
  readingFull = true,
): boolean {
  return input.onShortUnavailable?.(error, chosen, readingFull) ?? false;
}

function newSession(messageId: string): Session {
  return {
    messageId,
    controller: new AbortController(),
    parts: [],
    partsDirectory: null,
    whole: null,
    done: false,
    item: 0,
    waiting: false,
    resume: true,
    pendingSeek: null,
  };
}

async function readProvider(input: SpeechRequest) {
  const settings = await loadSpeechSettings();
  const provider = input.provider ?? activeSpeechProvider(settings);
  if (!provider) throw new SpeechNotConfiguredError("Add a voice provider to read messages aloud.");
  const problem = speechProviderProblem(provider);
  if (problem)
    throw new SpeechNotConfiguredError(`${provider.name || "Voice provider"}: ${problem}`);
  return { provider, playbackRate: settings.playbackRate };
}

/** Synthesizes `spoken` into `current`, calling `onPart` for each part while `isLive()`. */
async function synthesize(
  current: Session,
  spoken: SpokenText,
  provider: SpeechProviderConfig,
  isLive: () => boolean,
  onPart: () => void,
): Promise<void> {
  const key = await digestStringAsync(
    CryptoDigestAlgorithm.SHA256,
    `${spoken.mode}:${speechCacheKeySource(provider, spoken.text)}`,
  );
  const { file } = cacheFile(key);
  if (!isLive()) return;

  if (file.exists) {
    current.whole = { uri: file.uri, duration: null };
    current.done = true;
    onPart();
    return;
  }

  const playing = session !== current ? (session?.partsDirectory ?? null) : null;
  const partsDirectory = createPartsDirectory(key, playing);
  current.partsDirectory = partsDirectory;
  const pieces = await synthesizeSpeechParts(provider, planMessageSpeech(spoken.text), {
    signal: current.controller.signal,
    onPart: (piece, index) => {
      if (!isLive()) return;
      const part = new File(partsDirectory, `${index}.wav`);
      part.writeSync(encodeWav([piece]));
      current.parts.push({ uri: part.uri, duration: pcmDuration(piece) });
      onPart();
    },
  });
  if (!isLive()) return;
  const uri = await writeCachedWav(key, encodeWav(pieces));
  if (!isLive()) return;
  current.whole = { uri, duration: speechTimelineDuration(partDurations(current)) };
  current.done = true;
  if (session === current && current.waiting) finishSpeech();
}

/**
 * Writes and synthesizes the short version while the full reply plays on, then hands the player
 * over at its first part. Until then a failure leaves the full reply playing.
 */
async function switchToShort(input: SpeechRequest): Promise<void> {
  const next = newSession(input.messageId);
  pendingShort = next;
  setState({ ...state, writingShort: true });
  const failed = (error: unknown) => {
    if (pendingShort !== next) return;
    cancelShortSwitch();
    if (!session) {
      // The full reply ended while the short version was written; the next press reads it in full.
      stopSpeech();
      const told = shortUnavailable(input, error, true, false);
      setState({ ...IDLE, messageId: input.messageId, shortUnavailable: told });
      return;
    }
    const told = shortUnavailable(input, error, true);
    setState({ ...state, writingShort: false, shortAvailable: false, shortUnavailable: told });
  };
  let provider: SpeechProviderConfig;
  try {
    ({ provider } = await readProvider(input));
  } catch (error) {
    if (pendingShort === next) {
      cancelShortSwitch();
      if (session) setState({ ...state, writingShort: false });
      else stopSpeech();
    }
    throw error;
  }
  if (pendingShort !== next) return;
  const spoken = await resolveSpokenText({
    mode: "short",
    fullText: input.markdown,
    loadSummary: input.loadSummary ?? null,
  });
  if (pendingShort !== next) return;
  if (spoken.shortUnavailable !== undefined) return failed(spoken.shortUnavailable);
  try {
    await synthesize(
      next,
      spoken,
      provider,
      () => pendingShort === next || session === next,
      () => (pendingShort === next ? takeOver(next, input.title) : onPartReady(next, input.title)),
    );
  } catch (error) {
    if (next.controller.signal.aborted) return;
    if (pendingShort === next) return failed(error);
    if (session !== next) return;
    next.done = true;
    if (next.waiting) stopSpeech();
    throw error;
  }
}

/** The short version's first part replaces the full reply, keeping the session and lock screen. */
function takeOver(next: Session, title: string) {
  const outgoing = session;
  pendingShort = null;
  if (outgoing) {
    // A reader who paused the full reply gets the short version paused, not out loud.
    next.resume = outgoing.waiting ? outgoing.resume : state.phase !== "paused";
    discardSession(outgoing);
  }
  session = next;
  setState({
    ...IDLE,
    messageId: next.messageId,
    mode: "short",
    shortAvailable: true,
    phase: "preparing",
  });
  onPartReady(next, title);
}

function cancelShortSwitch() {
  const next = pendingShort;
  pendingShort = null;
  if (next) discardSession(next);
}

async function startReading(
  input: SpeechRequest,
  requestedMode: SpeechReadMode,
  chosen: boolean,
  shortKnownUnavailable = false,
): Promise<void> {
  stopSpeech();
  const { provider, playbackRate: rate } = await readProvider(input);
  // Another message may have started while settings loaded.
  stopSpeech();

  playbackRate = rate;
  setState({
    ...IDLE,
    messageId: input.messageId,
    mode: requestedMode,
    shortAvailable: Boolean(input.loadSummary) && !shortKnownUnavailable,
    writingShort: requestedMode === "short",
    phase: "preparing",
  });
  // Claims the message before any await, so a newer request can tell this one is stale.
  const current = newSession(input.messageId);
  session = current;
  let active: boolean;
  try {
    // Before the summary is written, while the app is surely in the foreground.
    active = await claimAudioSession();
  } catch (error) {
    if (session === current) stopSpeech();
    throw error;
  }
  if (session !== current) return;
  if (!active) return stopSpeech();
  try {
    void holdSession().catch(() => {});
    const spoken = await resolveSpokenText({
      mode: requestedMode,
      fullText: input.markdown,
      loadSummary: input.loadSummary ?? null,
    });
    if (session !== current) return;
    setState(
      spoken.shortUnavailable === undefined
        ? { ...state, writingShort: false }
        : {
            // Offering Short again would only repeat the failed request.
            ...state,
            writingShort: false,
            mode: "full",
            shortAvailable: false,
            shortUnavailable: shortUnavailable(input, spoken.shortUnavailable, chosen),
          },
    );
    await synthesize(
      current,
      spoken,
      provider,
      () => session === current,
      () => onPartReady(current, input.title),
    );
  } catch (error) {
    if (session !== current || current.controller.signal.aborted) return;
    // Keep playing what arrived; the message ends early.
    current.done = true;
    if (current.parts.length === 0 || current.waiting) stopSpeech();
    throw error;
  }
}

export function toggleSpeechPause() {
  if (state.buffering) return;
  if (state.phase === "playing") player?.pause();
  else if (state.phase === "paused") player?.play();
}

export function seekSpeech(deltaSeconds: number) {
  const current = session;
  if (!current || state.phase === "preparing") return;
  goTo(
    state.currentTime + deltaSeconds,
    current.waiting ? current.resume : (current.pendingSeek?.play ?? state.phase === "playing"),
  );
}

export function setSpeechPlaybackRate(rate: number) {
  playbackRate = rate;
  player?.setPlaybackRate(rate, "high");
}

/** Ends playback at the end of the audio; a short version then offers the full reply. */
function finishSpeech() {
  const ended = state;
  if (pendingShort) {
    // The short version the reader chose is still being written; it plays once it arrives.
    const current = session;
    session = null;
    if (current) discardSession(current);
    setState({ ...ended, phase: "preparing", currentTime: 0, duration: 0, buffering: false });
    void holdSession().catch(() => {});
    return;
  }
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

/**
 * Ends reading and releases the audio session. Handoffs between sessions skip this, because iOS
 * cannot reactivate a released session from the background.
 */
export function stopSpeech() {
  cancelShortSwitch();
  const current = session;
  session = null;
  if (current) discardSession(current);
  hold = null;
  const token = audioToken;
  audioToken = null;
  if (player && (current || token)) {
    player.pause();
    player.clearLockScreenControls();
  }
  if (token) void releaseAudioSession(token).catch(() => {});
  if (state.messageId !== null) setState(IDLE);
}

/** Drops a session's synthesis and part files; the audio session and player stay as they are. */
function discardSession(current: Session) {
  current.controller.abort();
  try {
    current.partsDirectory?.delete();
  } catch {}
}

export function currentSpeechPhase(): SpeechPhase {
  return state.phase;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Re-renders only for the message being read, so other rows stay still while audio plays. */
export function useSpeechPlayback(messageId: string): SpeechPlaybackState {
  return useSyncExternalStore(subscribe, () => (state.messageId === messageId ? state : IDLE));
}
