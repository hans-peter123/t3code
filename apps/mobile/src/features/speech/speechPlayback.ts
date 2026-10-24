import { CryptoDigestAlgorithm, digestStringAsync } from "expo-crypto";
import {
  type AudioPlayer,
  type AudioStatus,
  createAudioPlayer,
  setAudioModeAsync,
  setIsAudioActiveAsync,
} from "expo-audio";
import { useSyncExternalStore } from "react";

import { SPEECH_CHUNK_LENGTH, synthesizeSpeech } from "./speechProviders";
import {
  activeSpeechProvider,
  loadSpeechSettings,
  speechProviderProblem,
  type SpeechProviderConfig,
} from "./speechSettings";
import { markdownToSpeechText, splitSpeechText } from "./speechText";
import { encodeWav, type PcmAudio } from "./wav";

export const SPEECH_SKIP_SECONDS = 15;
const SYNTHESIS_CONCURRENCY = 3;
const CACHE_DIRECTORY = "speech";
const CACHE_LIMIT = 24;

export type SpeechPhase = "idle" | "preparing" | "playing" | "paused";

export interface SpeechPlaybackState {
  readonly messageId: string | null;
  readonly phase: SpeechPhase;
  readonly currentTime: number;
  readonly duration: number;
}

export class SpeechNotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SpeechNotConfiguredError";
  }
}

const IDLE: SpeechPlaybackState = { messageId: null, phase: "idle", currentTime: 0, duration: 0 };

let state = IDLE;
let player: AudioPlayer | null = null;
let request: AbortController | null = null;
const listeners = new Set<() => void>();

function setState(next: SpeechPlaybackState) {
  state = next;
  for (const listener of listeners) listener();
}

function onStatus(status: AudioStatus) {
  if (state.messageId === null || state.phase === "preparing") return;
  if (status.didJustFinish) {
    stopSpeech();
    return;
  }
  setState({
    ...state,
    phase: status.playing ? "playing" : "paused",
    currentTime: status.currentTime,
    duration: status.duration || state.duration,
  });
}

function ensurePlayer(): AudioPlayer {
  if (!player) {
    player = createAudioPlayer(null, { updateInterval: 250 });
    player.addListener("playbackStatusUpdate", onStatus);
  }
  return player;
}

async function mapConcurrent<T, R>(
  items: readonly T[],
  limit: number,
  map: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = Array.from({ length: items.length });
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await map(items[index]!, index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function speechFile(provider: SpeechProviderConfig, markdown: string, signal: AbortSignal) {
  const { Directory, File, Paths } = await import("expo-file-system");
  const text = markdownToSpeechText(markdown);
  if (!text) throw new Error("This message has nothing to read aloud.");
  const key = await digestStringAsync(
    CryptoDigestAlgorithm.SHA256,
    JSON.stringify([provider.kind, provider.baseUrl, provider.model, provider.voice, text]),
  );
  const directory = new Directory(Paths.cache, CACHE_DIRECTORY);
  directory.create({ idempotent: true, intermediates: true });
  const file = new File(directory, `${key}.wav`);
  if (file.exists) return file.uri;

  const chunks = splitSpeechText(text, SPEECH_CHUNK_LENGTH);
  const pieces = await mapConcurrent<string, PcmAudio>(
    chunks,
    SYNTHESIS_CONCURRENCY,
    (chunk, index) =>
      synthesizeSpeech(provider, {
        text: chunk,
        previousText: chunks[index - 1],
        nextText: chunks[index + 1],
        signal,
      }),
  );
  signal.throwIfAborted();

  const cached = directory.list().filter((entry) => entry instanceof File);
  if (cached.length >= CACHE_LIMIT) {
    for (const entry of cached) entry.delete();
  }
  await file.write(encodeWav(pieces));
  return file.uri;
}

/** Starts reading a message, or toggles pause when that message is already loaded. */
export async function speakMessage(input: {
  readonly messageId: string;
  readonly markdown: string;
  readonly title: string;
}): Promise<void> {
  if (state.messageId === input.messageId) {
    if (state.phase === "playing") player?.pause();
    else if (state.phase === "paused") player?.play();
    return;
  }
  stopSpeech();
  const settings = await loadSpeechSettings();
  const provider = activeSpeechProvider(settings);
  if (!provider) throw new SpeechNotConfiguredError("Add a voice provider to read messages aloud.");
  const problem = speechProviderProblem(provider);
  if (problem)
    throw new SpeechNotConfiguredError(`${provider.name || "Voice provider"}: ${problem}`);

  const controller = new AbortController();
  request = controller;
  setState({ messageId: input.messageId, phase: "preparing", currentTime: 0, duration: 0 });
  try {
    const uri = await speechFile(provider, input.markdown, controller.signal);
    if (request !== controller) return;
    await setAudioModeAsync({
      allowsRecording: false,
      interruptionMode: "doNotMix",
      playsInSilentMode: true,
      shouldPlayInBackground: true,
    });
    await setIsAudioActiveAsync(true);
    if (request !== controller) return;
    request = null;
    const audio = ensurePlayer();
    audio.replace({ uri });
    audio.setPlaybackRate(settings.playbackRate, "high");
    setState({ ...state, phase: "playing" });
    audio.play();
    audio.setActiveForLockScreen(
      true,
      { title: input.title || "T3 Code", artist: "T3 Code" },
      { showSeekBackward: true, showSeekForward: true },
    );
  } catch (error) {
    if (request !== controller) return;
    request = null;
    setState(IDLE);
    throw error;
  }
}

export function seekSpeech(deltaSeconds: number) {
  if (!player || state.messageId === null || state.phase === "preparing") return;
  const target = Math.max(0, Math.min(state.currentTime + deltaSeconds, state.duration));
  setState({ ...state, currentTime: target });
  void player.seekTo(target);
}

export function setSpeechPlaybackRate(rate: number) {
  player?.setPlaybackRate(rate, "high");
}

export function stopSpeech() {
  request?.abort();
  request = null;
  if (state.messageId === null) return;
  setState(IDLE);
  if (player) {
    player.pause();
    player.clearLockScreenControls();
    void setIsAudioActiveAsync(false).catch(() => {});
  }
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Re-renders only for the message being read, so other rows stay still while audio plays. */
export function useSpeechPlayback(messageId: string): SpeechPlaybackState {
  return useSyncExternalStore(subscribe, () => (state.messageId === messageId ? state : IDLE));
}
