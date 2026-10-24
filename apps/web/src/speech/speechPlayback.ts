import {
  activeSpeechProvider,
  speechCacheKeySource,
  speechProviderProblem,
  synthesizeMessageWav,
} from "@t3tools/client-runtime/speech";
import { useSyncExternalStore } from "react";

import { loadSpeechSettings } from "./speechSettings";

export const SPEECH_SKIP_SECONDS = 15;
const CACHE_LIMIT = 12;

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
let audio: HTMLAudioElement | null = null;
let request: AbortController | null = null;
// Object URLs of recently spoken messages, so replaying one does not call the provider again.
const cache = new Map<string, string>();
const listeners = new Set<() => void>();

function setState(next: SpeechPlaybackState) {
  state = next;
  for (const listener of listeners) listener();
}

function sync() {
  if (!audio || state.messageId === null || state.phase === "preparing") return;
  setState({
    ...state,
    phase: audio.paused ? "paused" : "playing",
    currentTime: audio.currentTime,
    duration: Number.isFinite(audio.duration) ? audio.duration : state.duration,
  });
  updatePositionState();
}

function updatePositionState() {
  if (!audio || !("mediaSession" in navigator) || !Number.isFinite(audio.duration)) return;
  try {
    navigator.mediaSession.setPositionState({
      duration: audio.duration,
      playbackRate: audio.playbackRate,
      position: Math.min(audio.currentTime, audio.duration),
    });
  } catch {}
}

function ensureAudio(): HTMLAudioElement {
  if (!audio) {
    audio = new Audio();
    for (const event of ["play", "pause", "timeupdate", "durationchange", "seeked"]) {
      audio.addEventListener(event, sync);
    }
    audio.addEventListener("ended", stopSpeech);
  }
  return audio;
}

/** Media keys, the macOS Now Playing widget, and headphones control the message being read. */
function claimMediaSession(title: string) {
  if (!("mediaSession" in navigator)) return;
  const session = navigator.mediaSession;
  session.metadata = new MediaMetadata({ title: title || "T3 Code", artist: "T3 Code" });
  session.setActionHandler("play", () => void audio?.play());
  session.setActionHandler("pause", () => audio?.pause());
  session.setActionHandler("stop", stopSpeech);
  session.setActionHandler("seekbackward", (details) =>
    seekSpeech(-(details.seekOffset ?? SPEECH_SKIP_SECONDS)),
  );
  session.setActionHandler("seekforward", (details) =>
    seekSpeech(details.seekOffset ?? SPEECH_SKIP_SECONDS),
  );
  session.setActionHandler("seekto", (details) => {
    if (audio && details.seekTime !== undefined) audio.currentTime = details.seekTime;
  });
}

function releaseMediaSession() {
  if (!("mediaSession" in navigator)) return;
  const session = navigator.mediaSession;
  session.metadata = null;
  for (const action of [
    "play",
    "pause",
    "stop",
    "seekbackward",
    "seekforward",
    "seekto",
  ] as const) {
    session.setActionHandler(action, null);
  }
}

function remember(key: string, url: string) {
  cache.set(key, url);
  while (cache.size > CACHE_LIMIT) {
    const [oldest, oldestUrl] = cache.entries().next().value!;
    cache.delete(oldest);
    URL.revokeObjectURL(oldestUrl);
  }
}

/** Starts reading a message, or toggles pause when that message is already loaded. */
export async function speakMessage(input: {
  readonly messageId: string;
  readonly markdown: string;
  readonly title: string;
}): Promise<void> {
  if (state.messageId === input.messageId) {
    if (state.phase === "playing") audio?.pause();
    else if (state.phase === "paused") void audio?.play();
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
    const key = speechCacheKeySource(provider, input.markdown);
    let url = cache.get(key);
    if (!url) {
      const wav = await synthesizeMessageWav(provider, input.markdown, controller.signal);
      url = URL.createObjectURL(new Blob([wav as Uint8Array<ArrayBuffer>], { type: "audio/wav" }));
      remember(key, url);
    }
    if (request !== controller) return;
    request = null;
    const element = ensureAudio();
    element.src = url;
    element.playbackRate = settings.playbackRate;
    setState({ ...state, phase: "playing" });
    claimMediaSession(input.title);
    await element.play();
  } catch (error) {
    if (request !== controller && request !== null) return;
    request = null;
    if (state.messageId === input.messageId) setState(IDLE);
    if (controller.signal.aborted) return;
    throw error;
  }
}

export function seekSpeech(deltaSeconds: number) {
  if (!audio || state.messageId === null || state.phase === "preparing") return;
  const duration = Number.isFinite(audio.duration) ? audio.duration : state.duration;
  audio.currentTime = Math.max(0, Math.min(audio.currentTime + deltaSeconds, duration));
}

export function setSpeechPlaybackRate(rate: number) {
  if (audio) audio.playbackRate = rate;
}

export function stopSpeech() {
  request?.abort();
  request = null;
  if (state.messageId === null) return;
  setState(IDLE);
  if (audio) {
    audio.pause();
    audio.removeAttribute("src");
    audio.load();
  }
  releaseMediaSession();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Re-renders only for the message being read, so other rows stay still while audio plays. */
export function useSpeechPlayback(messageId: string): SpeechPlaybackState {
  return useSyncExternalStore(subscribe, () => (state.messageId === messageId ? state : IDLE));
}
