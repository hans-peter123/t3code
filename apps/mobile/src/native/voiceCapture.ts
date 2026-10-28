import { requireOptionalNativeModule } from "expo";

interface VoiceCaptureSegment {
  readonly uri: string | null;
  readonly seconds: number;
  /** Highest sample in the segment, 0 to 1. */
  readonly peak: number;
}

interface VoiceCaptureModule {
  start(): Promise<void>;
  beginSegment(path: string): Promise<void>;
  endSegment(): Promise<VoiceCaptureSegment>;
  status(): { readonly running: boolean; readonly level: number; readonly recording: boolean };
  stop(): Promise<void>;
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
