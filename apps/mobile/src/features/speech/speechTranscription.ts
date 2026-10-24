import { transcribeAudio } from "@t3tools/client-runtime/speech";
import {
  VoiceTranscriptionError,
  throwIfVoiceTranscriptionAborted,
  type VoiceTranscriber,
} from "@t3tools/client-runtime/voice-input";

import { getLocalVoiceTranscriber } from "../../native/voiceTranscription";
import {
  currentSpeechSettings,
  loadSpeechSettings,
  type SpeechProviderConfig,
  transcriptionProvider,
  transcriptionProviderProblem,
  useSpeechSettings,
} from "./speechSettings";

function recordingPart(uri: string) {
  const name = uri.split("/").pop() || "recording.m4a";
  const extension = name.split(".").pop()?.toLowerCase();
  const type =
    extension === "wav" ? "audio/wav" : extension === "caf" ? "audio/x-caf" : "audio/m4a";
  // React Native's FormData uploads a local file from this shape.
  return { file: { uri, name, type } as unknown as Blob, name };
}

/** Uploads a local recording to the provider's speech-to-text endpoint. */
export function transcribeRecording(
  provider: SpeechProviderConfig,
  uri: string,
  signal: AbortSignal,
): Promise<string> {
  const part = recordingPart(uri);
  return transcribeAudio(provider, part.file, part.name, signal);
}

function remoteTranscriber(provider: SpeechProviderConfig): VoiceTranscriber {
  return {
    prepare: async ({ signal }) => {
      throwIfVoiceTranscriptionAborted(signal);
      return {
        locale: Intl.DateTimeFormat().resolvedOptions().locale,
        transcribe: async (uri, options) => {
          try {
            return await transcribeRecording(provider, uri, options.signal);
          } catch (error) {
            throwIfVoiceTranscriptionAborted(options.signal);
            throw new VoiceTranscriptionError(
              "transcription-failed",
              error instanceof Error ? error.message : "Voice transcription failed.",
              { cause: error },
            );
          }
        },
      };
    },
  };
}

function configuredProvider(): SpeechProviderConfig | null {
  const provider = transcriptionProvider(currentSpeechSettings());
  return provider && transcriptionProviderProblem(provider) === null ? provider : null;
}

/** The dictation provider chosen in settings, or Apple's on-device recognition. */
export function getVoiceTranscriber(): VoiceTranscriber | null {
  const provider = configuredProvider();
  return provider ? remoteTranscriber(provider) : getLocalVoiceTranscriber();
}

/** Re-renders when the dictation provider changes, so the microphone appears without a restart. */
export function useVoiceTranscriberAvailable(): boolean {
  useSpeechSettings();
  return getVoiceTranscriber() !== null;
}

// Read the keychain at startup so the first recording already uses the chosen provider.
void loadSpeechSettings();
