import type { SpeechProviderConfig } from "./speechSettings";
import { parseWav, type PcmAudio } from "./wav";

/** Kept under every provider's per-request limit (gpt-4o-mini-tts takes about 2000 tokens). */
export const SPEECH_CHUNK_LENGTH = 1500;

const OPENAI_BASE_URL = "https://api.openai.com/v1";
const ELEVENLABS_BASE_URL = "https://api.elevenlabs.io/v1";
// OpenAI's raw `pcm` format and ElevenLabs' `pcm_24000` are both 24 kHz mono 16-bit.
const RAW_PCM_FORMAT = { sampleRate: 24_000, channels: 1 } as const;

export interface SpeechRequest {
  readonly text: string;
  /** Neighbouring text lets ElevenLabs keep intonation consistent across pieces. */
  readonly previousText?: string;
  readonly nextText?: string;
  readonly signal?: AbortSignal;
}

function trimSlash(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

async function responseError(response: Response, provider: string): Promise<Error> {
  let detail = "";
  try {
    const body = (await response.json()) as {
      error?: { message?: string } | string;
      detail?: { message?: string } | string;
    };
    const candidate = body.error ?? body.detail;
    detail = typeof candidate === "string" ? candidate : (candidate?.message ?? "");
  } catch {}
  return new Error(
    `${provider} returned ${response.status}${detail ? `: ${detail}` : ""}`.slice(0, 300),
  );
}

async function bytes(response: Response): Promise<Uint8Array> {
  return new Uint8Array(await response.arrayBuffer());
}

function rawPcm(samples: Uint8Array): PcmAudio {
  return {
    format: RAW_PCM_FORMAT,
    samples: samples.subarray(0, samples.length - (samples.length % 2)),
  };
}

export async function synthesizeSpeech(
  provider: SpeechProviderConfig,
  request: SpeechRequest,
): Promise<PcmAudio> {
  if (provider.kind === "elevenlabs") {
    const response = await fetch(
      `${ELEVENLABS_BASE_URL}/text-to-speech/${encodeURIComponent(provider.voice.trim())}?output_format=pcm_24000`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "xi-api-key": provider.apiKey.trim() },
        body: JSON.stringify({
          text: request.text,
          model_id: provider.model.trim(),
          ...(request.previousText ? { previous_text: request.previousText } : {}),
          ...(request.nextText ? { next_text: request.nextText } : {}),
        }),
        signal: request.signal,
      },
    );
    if (!response.ok) throw await responseError(response, "ElevenLabs");
    return rawPcm(await bytes(response));
  }

  const custom = provider.kind === "openai-compatible";
  const apiKey = provider.apiKey.trim();
  const response = await fetch(
    `${custom ? trimSlash(provider.baseUrl) : OPENAI_BASE_URL}/audio/speech`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: provider.model.trim(),
        voice: provider.voice.trim(),
        input: request.text,
        // Self-hosted servers vary in raw PCM support; WAV carries its own format.
        response_format: custom ? "wav" : "pcm",
      }),
      signal: request.signal,
    },
  );
  if (!response.ok) throw await responseError(response, custom ? "The voice server" : "OpenAI");
  return custom ? parseWav(await bytes(response)) : rawPcm(await bytes(response));
}

export interface SpeechVoice {
  readonly id: string;
  readonly name: string;
}

export async function listElevenLabsVoices(apiKey: string): Promise<SpeechVoice[]> {
  const response = await fetch(`${ELEVENLABS_BASE_URL}/voices`, {
    headers: { "xi-api-key": apiKey.trim() },
  });
  if (!response.ok) throw await responseError(response, "ElevenLabs");
  const body = (await response.json()) as {
    voices?: ReadonlyArray<{ voice_id?: string; name?: string }>;
  };
  return (body.voices ?? []).flatMap((voice) =>
    voice.voice_id ? [{ id: voice.voice_id, name: voice.name ?? voice.voice_id }] : [],
  );
}
