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

const OPENAI_BASE_URL = "https://api.openai.com/v1";
const ELEVENLABS_BASE_URL = "https://api.elevenlabs.io/v1";

function recordingPart(uri: string) {
  const name = uri.split("/").pop() || "recording.m4a";
  const extension = name.split(".").pop()?.toLowerCase();
  const type =
    extension === "wav" ? "audio/wav" : extension === "caf" ? "audio/x-caf" : "audio/m4a";
  // React Native's FormData uploads a local file from this shape.
  return { uri, name, type } as unknown as Blob;
}

async function errorDetail(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as {
      error?: { message?: string } | string;
      detail?: { message?: string } | string;
    };
    const candidate = body.error ?? body.detail;
    return typeof candidate === "string" ? candidate : (candidate?.message ?? "");
  } catch {
    return "";
  }
}

/** Uploads a recording to the provider's speech-to-text endpoint and returns the text. */
export async function transcribeRecording(
  provider: SpeechProviderConfig,
  uri: string,
  signal: AbortSignal,
): Promise<string> {
  const form = new FormData();
  form.append("file", recordingPart(uri));
  const apiKey = provider.apiKey.trim();
  let url: string;
  let headers: Record<string, string>;
  if (provider.kind === "elevenlabs") {
    url = `${ELEVENLABS_BASE_URL}/speech-to-text`;
    headers = { "xi-api-key": apiKey };
    form.append("model_id", provider.transcriptionModel.trim());
  } else {
    const base =
      provider.kind === "openai-compatible"
        ? provider.baseUrl.trim().replace(/\/+$/, "")
        : OPENAI_BASE_URL;
    url = `${base}/audio/transcriptions`;
    headers = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
    form.append("model", provider.transcriptionModel.trim());
    form.append("response_format", "json");
  }

  const response = await fetch(url, { method: "POST", headers, body: form, signal });
  if (!response.ok) {
    const detail = await errorDetail(response);
    throw new Error(`Transcription returned ${response.status}${detail ? `: ${detail}` : ""}`);
  }
  const body = (await response.json()) as { text?: unknown };
  return typeof body.text === "string" ? body.text.trim() : "";
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
