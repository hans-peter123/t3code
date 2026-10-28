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
}

/** iOS only: one microphone input that keeps running in the background. Null elsewhere. */
export const VoiceCapture = requireOptionalNativeModule<VoiceCaptureModule>("T3VoiceCapture");
