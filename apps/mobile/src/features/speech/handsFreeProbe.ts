// @effect-diagnostics globalConsole:off - a temporary device probe for the hands-free mode.
import {
  activeSpeechProvider,
  encodeWav,
  planMessageSpeech,
  silentWav,
  synthesizeSpeechParts,
  type PcmAudio,
} from "@t3tools/client-runtime/speech";
import {
  AudioModule,
  createAudioPlayer,
  requestRecordingPermissionsAsync,
  RecordingPresets,
  setAudioModeAsync,
  setIsAudioActiveAsync,
  type AudioPlayer,
} from "expo-audio";
import { AppState } from "react-native";

import { getVoiceTranscriber } from "./speechTranscription";
import { loadSpeechSettings } from "./speechSettings";
import { stopSpeech } from "./speechPlayback";

/**
 * Checks on a real iPhone what the hands-free mode depends on: one audio session that plays and
 * records with the screen locked, lock screen and AirPods play/pause as "Done", and the app staying
 * alive while the agent works. Every step is logged so a tester can report what happened.
 */
export type ProbePhase = "off" | "speaking" | "listening" | "transcribing" | "waiting";

const WAIT_SECONDS = 30;
const RECORDING_OPTIONS = {
  ...RecordingPresets.HIGH_QUALITY,
  ...RecordingPresets.HIGH_QUALITY.ios,
  extension: RecordingPresets.HIGH_QUALITY.extension,
  sampleRate: RecordingPresets.HIGH_QUALITY.sampleRate,
  numberOfChannels: RecordingPresets.HIGH_QUALITY.numberOfChannels,
  bitRate: RecordingPresets.HIGH_QUALITY.bitRate,
};

function tone(): Uint8Array {
  const sampleRate = 16_000;
  const length = Math.round(sampleRate * 0.18);
  const samples = new Uint8Array(length * 2);
  const view = new DataView(samples.buffer);
  for (let i = 0; i < length; i++) {
    const fade = Math.min(1, i / 400, (length - i) / 400);
    view.setInt16(i * 2, Math.sin((2 * Math.PI * 880 * i) / sampleRate) * 9000 * fade, true);
  }
  return encodeWav([{ format: { sampleRate, channels: 1 }, samples }]);
}

async function writeCache(name: string, bytes: Uint8Array): Promise<string> {
  const { File, Paths } = await import("expo-file-system");
  const file = new File(Paths.cache, name);
  if (file.exists) file.delete();
  file.write(bytes);
  return file.uri;
}

export class HandsFreeProbe {
  phase: ProbePhase = "off";
  private keepAlive: AudioPlayer | null = null;
  private voice: AudioPlayer | null = null;
  private recorder: InstanceType<typeof AudioModule.AudioRecorder> | null = null;
  private controller = new AbortController();
  private finishVoice: (() => void) | null = null;
  private finishListening: (() => void) | null = null;
  private keepAlivePlaying = false;
  /** Set while the probe itself restarts the silent loop, so that change is not a press. */
  private resuming = false;
  private appStateSubscription: { remove(): void } | null = null;

  constructor(
    private readonly log: (line: string) => void,
    private readonly onPhase: (phase: ProbePhase) => void,
  ) {}

  private setPhase(phase: ProbePhase) {
    this.phase = phase;
    this.onPhase(phase);
    this.log(`phase → ${phase} (app ${AppState.currentState})`);
  }

  async start() {
    if (this.phase !== "off") return;
    this.controller = new AbortController();
    stopSpeech();
    const permission = await requestRecordingPermissionsAsync();
    this.log(`microphone permission: ${permission.granted ? "granted" : "denied"}`);
    if (!permission.granted) return;

    await setAudioModeAsync({
      allowsRecording: true,
      allowsBackgroundRecording: true,
      shouldPlayInBackground: true,
      playsInSilentMode: true,
      interruptionMode: "doNotMix",
    });
    await setIsAudioActiveAsync(true);
    this.log("audio session: playAndRecord, background, active");

    this.appStateSubscription = AppState.addEventListener("change", (state) =>
      this.log(`app state → ${state}`),
    );

    const silence = await writeCache("hands-free-silence.wav", silentWav());
    const keepAlive = createAudioPlayer({ uri: silence }, { keepAudioSessionActive: true });
    keepAlive.loop = true;
    keepAlive.volume = 0;
    keepAlive.addListener("playbackStatusUpdate", (status) => {
      if (status.playing === this.keepAlivePlaying) return;
      this.keepAlivePlaying = status.playing;
      if (status.playing && this.resuming) {
        this.resuming = false;
        return;
      }
      this.log(`lock screen / AirPods: keep-alive ${status.playing ? "play" : "pause"}`);
      // The silent loop never pauses by itself, so a change is a press on a remote control.
      if (this.phase !== "off") this.remotePress();
    });
    this.keepAlivePlaying = true;
    keepAlive.play();
    keepAlive.setActiveForLockScreen(true, { title: "Gespräch", artist: "T3 Code" });
    this.keepAlive = keepAlive;

    this.voice = createAudioPlayer(null, { keepAudioSessionActive: true });
    this.voice.addListener("playbackStatusUpdate", (status) => {
      if (status.didJustFinish) this.finishVoice?.();
    });

    void this.loop();
  }

  /** On screen, lock screen or AirPods: stops reading, or finishes the recording. */
  remotePress() {
    if (this.phase === "speaking") {
      this.log("press while speaking → skip to listening");
      this.voice?.pause();
      this.finishVoice?.();
    } else if (this.phase === "listening") {
      this.log("press while listening → done");
      this.finishListening?.();
    } else {
      this.log(`press ignored in ${this.phase}`);
    }
    // Keep the silent loop running so the app keeps its background audio.
    if (this.keepAlive && !this.keepAlivePlaying) {
      this.resuming = true;
      this.keepAlive.play();
    }
  }

  async stop() {
    if (this.phase === "off") return;
    this.controller.abort();
    this.finishVoice?.();
    this.finishListening?.();
    this.appStateSubscription?.remove();
    try {
      await this.recorder?.stop();
    } catch {}
    this.recorder?.release();
    this.recorder = null;
    this.keepAlive?.setActiveForLockScreen(false);
    this.keepAlive?.release();
    this.voice?.release();
    this.keepAlive = null;
    this.voice = null;
    await setAudioModeAsync({ allowsRecording: false, allowsBackgroundRecording: false });
    await setIsAudioActiveAsync(false);
    this.setPhase("off");
  }

  private get aborted() {
    return this.controller.signal.aborted;
  }

  private async loop() {
    let text =
      "Freihand-Test. Nach dem Ton sprichst du. Wenn du fertig bist, drück Fertig, die Pause-Taste auf dem Sperrbildschirm oder tipp auf deine AirPods.";
    for (let round = 1; !this.aborted; round++) {
      this.log(`round ${round}`);
      await this.speak(text);
      if (this.aborted) return;
      const uri = await this.listen();
      if (this.aborted) return;
      const heard = uri ? await this.transcribe(uri) : "";
      if (this.aborted) return;
      await this.speak(heard ? `Verstanden: ${heard}` : "Ich habe nichts verstanden.");
      if (this.aborted) return;
      this.setPhase("waiting");
      this.log(`waiting ${WAIT_SECONDS}s in silence, like an agent at work`);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, WAIT_SECONDS * 1000);
        this.controller.signal.addEventListener("abort", () => {
          clearTimeout(timer);
          resolve();
        });
      });
      this.log(`woke after wait (app ${AppState.currentState})`);
      text = "Die Antwort ist da. Sprich nach dem Ton weiter.";
    }
  }

  private async play(uri: string) {
    const voice = this.voice;
    if (!voice) return;
    await new Promise<void>((resolve) => {
      this.finishVoice = resolve;
      voice.replace({ uri });
      voice.play();
    });
    this.finishVoice = null;
  }

  private async speak(text: string) {
    this.setPhase("speaking");
    const provider = activeSpeechProvider(await loadSpeechSettings());
    if (!provider) {
      this.log("no read aloud provider: playing only the tone");
      await this.play(await writeCache("hands-free-tone.wav", tone()));
      return;
    }
    try {
      const pieces: PcmAudio[] = await synthesizeSpeechParts(provider, planMessageSpeech(text), {
        signal: this.controller.signal,
        onPart: () => {},
      });
      this.log(`synthesized ${pieces.length} part(s) (app ${AppState.currentState})`);
      await this.play(await writeCache("hands-free-voice.wav", encodeWav(pieces)));
    } catch (error) {
      this.log(`speech failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async listen(): Promise<string | null> {
    await this.play(await writeCache("hands-free-tone.wav", tone()));
    this.setPhase("listening");
    try {
      const recorder = new AudioModule.AudioRecorder(RECORDING_OPTIONS);
      this.recorder = recorder;
      await recorder.prepareToRecordAsync();
      recorder.record({ forDuration: 600 });
      this.log(`recording started (app ${AppState.currentState})`);
      await new Promise<void>((resolve) => {
        this.finishListening = resolve;
      });
      this.finishListening = null;
      const seconds = Math.round(recorder.getStatus().durationMillis / 100) / 10;
      await recorder.stop();
      this.log(`recording stopped after ${seconds}s`);
      const uri = recorder.uri;
      recorder.release();
      this.recorder = null;
      return uri;
    } catch (error) {
      this.log(`recording failed: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  private async transcribe(uri: string): Promise<string> {
    this.setPhase("transcribing");
    const transcriber = getVoiceTranscriber();
    if (!transcriber) {
      this.log("no transcriber available");
      return "";
    }
    try {
      const prepared = await transcriber.prepare({ signal: this.controller.signal });
      const text = (await prepared.transcribe(uri, { signal: this.controller.signal })).trim();
      this.log(`transcribed (${prepared.locale}): "${text}"`);
      return text;
    } catch (error) {
      this.log(`transcription failed: ${error instanceof Error ? error.message : String(error)}`);
      return "";
    }
  }
}
