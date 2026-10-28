import { transcribeAudio } from "@t3tools/client-runtime/speech";
import { File } from "expo-file-system";
import {
  VoiceTranscriptionError,
  throwIfVoiceTranscriptionAborted,
  type VoiceTranscriber,
} from "@t3tools/client-runtime/voice-input";

import { getLocalVoiceTranscriber } from "../../native/voiceTranscription";
import {
  type DictationContext,
  onDeviceDictationLocales,
  providerDictationLanguage,
} from "./dictationLanguage";
import {
  currentSpeechSettings,
  loadSpeechSettings,
  type SpeechProviderConfig,
  transcriptionProvider,
  transcriptionProviderProblem,
  useSpeechSettings,
} from "./speechSettings";

/**
 * The app's global fetch is Expo's. Its FormData serializer accepts strings, Blobs, or objects
 * with `bytes()`, and rejects React Native's `{ uri }` file shape. A plain object keeps that
 * check independent of how the native File class is exposed.
 */
export function recordingPart(uri: string) {
  const file = new File(uri);
  const name = file.name || "recording.m4a";
  const extension = name.split(".").pop()?.toLowerCase();
  const type =
    extension === "wav" ? "audio/wav" : extension === "caf" ? "audio/x-caf" : "audio/m4a";
  const part = { name, type, bytes: () => file.bytes() };
  return { file: part as unknown as Blob, name };
}

/** Uploads a local recording to the provider's speech-to-text endpoint. */
export function transcribeRecording(
  provider: SpeechProviderConfig,
  uri: string,
  signal: AbortSignal,
  language: string | null = null,
): Promise<string> {
  const part = recordingPart(uri);
  return transcribeAudio(provider, part.file, part.name, signal, language);
}

function remoteTranscriber(provider: SpeechProviderConfig): VoiceTranscriber {
  return {
    prepare: async ({ signal }) => {
      throwIfVoiceTranscriptionAborted(signal);
      const language = providerDictationLanguage();
      return {
        locale: language ?? Intl.DateTimeFormat().resolvedOptions().locale,
        transcribe: async (uri, options) => {
          try {
            return await transcribeRecording(provider, uri, options.signal, language);
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

/**
 * The dictation provider chosen in settings, or Apple's on-device recognition, listening for the
 * language chosen in settings. Apple's recognizer needs one, so it otherwise follows the thread's.
 */
export function getVoiceTranscriber(
  context: DictationContext | null = null,
): VoiceTranscriber | null {
  const provider = configuredProvider();
  return provider
    ? remoteTranscriber(provider)
    : getLocalVoiceTranscriber(() => onDeviceDictationLocales(context));
}

/** Re-renders when the dictation provider changes, so the microphone appears without a restart. */
export function useVoiceTranscriberAvailable(): boolean {
  useSpeechSettings();
  return getVoiceTranscriber() !== null;
}

// Read the keychain at startup so the first recording already uses the chosen provider.
void loadSpeechSettings();
