import { requireOptionalNativeModule, type EventSubscription } from "expo";

export interface VoiceCaptureSegment {
  /** A 16 kHz mono 16-bit WAV the caller deletes; null when no segment was open. */
  readonly uri: string | null;
  readonly seconds: number;
  /** Highest sample in the segment, 0 to 1. */
  readonly peak: number;
}

export interface VoiceCaptureState {
  /** The microphone delivers audio. */
  readonly running: boolean;
  /** A call or Siri holds the microphone; capture resumes when it ends. */
  readonly interrupted: boolean;
  /** Restarted in the background, where iOS may deliver only silence until `recover()`. */
  readonly suspect: boolean;
  /** Restarting after a route change or interruption failed. */
  readonly error?: string;
}

interface VoiceCaptureModule {
  /** Starts the microphone; call in the foreground; it keeps running in the background. */
  start(): Promise<void>;
  /** In the foreground: restarts an input that is interrupted, stopped or suspect. */
  recover(): Promise<void>;
  beginSegment(): Promise<void>;
  endSegment(): Promise<VoiceCaptureSegment>;
  /** Ends the open segment and deletes its file. */
  cancelSegment(): Promise<void>;
  status(): {
    readonly running: boolean;
    readonly interrupted: boolean;
    readonly suspect: boolean;
    /** A call, Siri or a lost route paused audio within the last moment. */
    readonly disrupted: boolean;
    readonly level: number;
    readonly recording: boolean;
  };
  /** Stops the microphone and deletes every segment file left. */
  stop(): Promise<void>;
  addListener(
    event: "onStateChange",
    listener: (state: VoiceCaptureState) => void,
  ): EventSubscription;
  /** The dominant language of the text, e.g. "de", or null when it is unclear. */
  detectLanguage(text: string): string | null;
  /** On-device dictation locales, or `fallback` without on-device dictation, with display names. */
  dictationLocales(
    fallback: readonly string[],
  ): Promise<readonly { readonly id: string; readonly name: string }[]>;
  /** On-device dictation locales whose model is already installed; empty before iOS 26. */
  installedDictationLocales(): Promise<readonly string[]>;
}

/**
 * iOS only: one microphone input that keeps running in the background, and the language
 * dictation listens for. Null elsewhere.
 */
export const VoiceCapture = requireOptionalNativeModule<VoiceCaptureModule>("T3VoiceCapture");
