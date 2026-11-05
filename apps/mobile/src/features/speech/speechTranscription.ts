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
            throw new VoiceTranscriptionError({
              code: "transcription-failed",
              message: error instanceof Error ? error.message : "Voice transcription failed.",
              cause: error,
            });
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
 * The dictation provider chosen in settings, then the environment upstream's Voice settings route
 * dictation to, then Apple's on-device recognition listening for the chosen or thread language.
 */
export function getVoiceTranscriber(
  localAvailable: boolean,
  context: DictationContext | null = null,
  environment?: { readonly transcriber: VoiceTranscriber | null } | null,
): VoiceTranscriber | null {
  const provider = configuredProvider();
  if (provider) return remoteTranscriber(provider);
  if (environment) return environment.transcriber;
  return localAvailable ? onDeviceTranscriber(context) : null;
}

function onDeviceTranscriber(context: DictationContext | null): VoiceTranscriber {
  return {
    prepare: async (options) => {
      const local = await getLocalVoiceTranscriber(() => onDeviceDictationLocales(context));
      if (!local) {
        throw new VoiceTranscriptionError({
          code: "unavailable",
          message: "Voice transcription is not available on this device.",
        });
      }
      return local.prepare(options);
    },
  };
}

/** Re-renders when the dictation provider changes, so the microphone appears without a restart. */
export function useVoiceTranscriberAvailable(fallbackAvailable: boolean): boolean {
  useSpeechSettings();
  return configuredProvider() !== null || fallbackAvailable;
}

// Read the keychain at startup so the first recording already uses the chosen provider.
void loadSpeechSettings();
