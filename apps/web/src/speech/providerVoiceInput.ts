import {
  encodeWav,
  transcribeAudio,
  transcriptionProvider,
  transcriptionProviderProblem,
  type SpeechProviderConfig,
  type SpeechSettings,
} from "@t3tools/client-runtime/speech";
import {
  throwIfVoiceTranscriptionAborted,
  VoiceTranscriptionError,
} from "@t3tools/client-runtime/voice-input";

import { createBrowserPcmCapture } from "./browserPcmCapture";

/** The dictation provider chosen in Settings → Speech, when it is ready to transcribe. */
export function readyTranscriptionProvider(settings: SpeechSettings): SpeechProviderConfig | null {
  const provider = transcriptionProvider(settings);
  return provider && transcriptionProviderProblem(provider) === null ? provider : null;
}

/** The capture yields 16 kHz mono Float32 PCM; providers take a WAV file. */
function float32PcmToWav(bytes: ArrayBuffer): Blob {
  const pcm = new Float32Array(bytes);
  const samples = new Uint8Array(pcm.length * 2);
  const view = new DataView(samples.buffer);
  for (let index = 0; index < pcm.length; index++) {
    const sample = Math.max(-1, Math.min(1, pcm[index]!));
    view.setInt16(index * 2, Math.round(sample * (sample < 0 ? 32768 : 32767)), true);
  }
  const wav = encodeWav([{ format: { sampleRate: 16_000, channels: 1 }, samples }]);
  return new Blob([wav.slice().buffer], { type: "audio/wav" });
}

/**
 * Upstream's recorder and voice controller, transcribed by the fork's own provider straight
 * from this client instead of through an environment.
 */
export function createProviderVoiceInputPlatform(input: {
  readonly getProvider: () => SpeechProviderConfig | null;
  readonly getLanguage: () => string;
  readonly getMicrophoneId: () => string;
  readonly onLevel: (level: number) => void;
  readonly onDurationLimit: () => void;
  readonly onError: (message: string) => void;
}) {
  return createBrowserPcmCapture(input, async () => {
    const language = input.getLanguage();
    return {
      locale: language,
      transcribe: async (uri, { signal }) => {
        const provider = input.getProvider();
        if (!provider)
          throw new VoiceTranscriptionError({
            code: "unavailable",
            message: "Choose a dictation provider in Settings → Speech.",
          });
        try {
          const response = await fetch(uri, { signal });
          const audio = float32PcmToWav(await response.arrayBuffer());
          const text = await transcribeAudio(
            provider,
            audio,
            "dictation.wav",
            signal,
            language === "auto" ? null : language,
          );
          throwIfVoiceTranscriptionAborted(signal);
          return text;
        } catch (cause) {
          throwIfVoiceTranscriptionAborted(signal);
          throw new VoiceTranscriptionError({
            code: "transcription-failed",
            message: cause instanceof Error ? cause.message : "Dictation failed.",
            cause,
          });
        }
      },
    };
  });
}
