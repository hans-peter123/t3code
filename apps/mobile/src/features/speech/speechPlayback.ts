import { CryptoDigestAlgorithm, digestStringAsync } from "expo-crypto";
import {
  type AudioPlayer,
  type AudioStatus,
  createAudioPlayer,
  setAudioModeAsync,
  setIsAudioActiveAsync,
} from "expo-audio";
import type { Directory as FsDirectory } from "expo-file-system";
import { useSyncExternalStore } from "react";

import {
  encodeWav,
  locateSpeechTime,
  pcmDuration,
  planMessageSpeech,
  speechCacheKeySource,
  speechPartStart,
  speechTimelineDuration,
  synthesizeSpeechParts,
} from "@t3tools/client-runtime/speech";
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
  partsDirectory: FsDirectory | null;
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
  phase: "idle",
  currentTime: 0,
  duration: 0,
  buffering: false,
};

let state = IDLE;
let player: AudioPlayer | null = null;
let session: Session | null = null;
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
    if (current.item === WHOLE) stopSpeech();
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
  current.item = item;
  current.waiting = false;
  current.pendingSeek = offset > 0 ? { offset, play } : null;
  // Paused first, so the player does not start the new item by itself before the seek.
  audio.pause();
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
    stopSpeech();
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
    setState({ ...state, phase: "playing" });
    load(current, current.whole ? WHOLE : 0, 0, true);
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

async function cacheFile(key: string) {
  const { Directory, File, Paths } = await import("expo-file-system");
  const directory = new Directory(Paths.cache, CACHE_DIRECTORY);
  directory.create({ idempotent: true, intermediates: true });
  return { directory, file: new File(directory, `${key}.wav`) };
}

async function writeCachedWav(key: string, wav: Uint8Array): Promise<string> {
  const { File } = await import("expo-file-system");
  const { directory, file } = await cacheFile(key);
  const cached = directory.list().filter((entry) => entry instanceof File);
  if (cached.length >= CACHE_LIMIT) {
    for (const entry of cached) entry.delete();
  }
  await file.write(wav);
  return file.uri;
}

/** A fresh directory for one message's part files; leftovers from earlier runs go first. */
async function createPartsDirectory(messageKey: string): Promise<FsDirectory> {
  const { Directory, Paths } = await import("expo-file-system");
  const root = new Directory(Paths.cache, PARTS_DIRECTORY);
  if (root.exists) root.delete();
  const directory = new Directory(root, messageKey);
  directory.create({ idempotent: true, intermediates: true });
  return directory;
}

/**
 * Starts reading a message, or toggles pause when that message is already loaded. Playback starts
 * with the first part while later parts are synthesized one request at a time; the promise settles
 * once every part is ready.
 */
export async function speakMessage(input: {
  readonly messageId: string;
  readonly markdown: string;
  readonly title: string;
  /** Plays with this provider instead of the one chosen for read aloud, e.g. a voice sample. */
  readonly provider?: SpeechProviderConfig;
}): Promise<void> {
  if (state.messageId === input.messageId) {
    if (state.buffering) return;
    if (state.phase === "playing") player?.pause();
    else if (state.phase === "paused") player?.play();
    return;
  }
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
  const controller = new AbortController();
  setState({ ...IDLE, messageId: input.messageId, phase: "preparing" });
  // Claims the message before any await, so a newer request can tell this one is stale.
  const current: Session = {
    messageId: input.messageId,
    controller,
    parts: [],
    partsDirectory: null,
    whole: null,
    done: false,
    item: 0,
    waiting: false,
    resume: true,
    pendingSeek: null,
  };
  session = current;
  try {
    const key = await digestStringAsync(
      CryptoDigestAlgorithm.SHA256,
      speechCacheKeySource(provider, input.markdown),
    );
    const { file } = await cacheFile(key);
    await setAudioModeAsync({
      allowsRecording: false,
      interruptionMode: "doNotMix",
      playsInSilentMode: true,
      shouldPlayInBackground: true,
    });
    await setIsAudioActiveAsync(true);
    if (session !== current) return;

    if (file.exists) {
      current.whole = { uri: file.uri, duration: null };
      current.done = true;
      onPartReady(current, input.title);
      return;
    }

    const { File } = await import("expo-file-system");
    const partsDirectory = await createPartsDirectory(key);
    if (session !== current) return;
    current.partsDirectory = partsDirectory;
    const pieces = await synthesizeSpeechParts(provider, planMessageSpeech(input.markdown), {
      signal: controller.signal,
      onPart: (piece, index) => {
        if (session !== current) return;
        const part = new File(partsDirectory, `${index}.wav`);
        part.writeSync(encodeWav([piece]));
        current.parts.push({ uri: part.uri, duration: pcmDuration(piece) });
        onPartReady(current, input.title);
      },
    });
    if (session !== current) return;
    const uri = await writeCachedWav(key, encodeWav(pieces));
    if (session !== current) return;
    current.whole = { uri, duration: speechTimelineDuration(partDurations(current)) };
    current.done = true;
    if (current.waiting) stopSpeech();
  } catch (error) {
    if (session !== current || controller.signal.aborted) return;
    // Keep playing what arrived; the message ends early.
    current.done = true;
    if (current.parts.length === 0 || current.waiting) stopSpeech();
    throw error;
  }
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

export function stopSpeech() {
  const current = session;
  if (!current) return;
  session = null;
  current.controller.abort();
  setState(IDLE);
  if (player) {
    player.pause();
    player.clearLockScreenControls();
    void setIsAudioActiveAsync(false).catch(() => {});
  }
  try {
    current.partsDirectory?.delete();
  } catch {}
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Re-renders only for the message being read, so other rows stay still while audio plays. */
export function useSpeechPlayback(messageId: string): SpeechPlaybackState {
  return useSyncExternalStore(subscribe, () => (state.messageId === messageId ? state : IDLE));
}
