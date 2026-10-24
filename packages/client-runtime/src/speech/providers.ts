// @effect-diagnostics globalFetch:off - shared by React Native and the web, which call plain fetch.
import type { SpeechProviderConfig } from "./settings.ts";
import { markdownToSpeechText, splitSpeechText } from "./text.ts";
import { encodeWav, parseWav, type PcmAudio } from "./wav.ts";

type SpeechFetch = (url: string, init: RequestInit) => Promise<Response>;

let speechFetch: SpeechFetch = (url, init) => fetch(url, init);

/** Lets a client route provider requests elsewhere, e.g. the desktop main process without CORS. */
export function setSpeechFetch(impl: SpeechFetch): void {
  speechFetch = impl;
}

/** Kept under every provider's per-request limit (gpt-4o-mini-tts takes about 2000 tokens). */
export const SPEECH_CHUNK_LENGTH = 1500;

const OPENAI_BASE_URL = "https://api.openai.com/v1";
const ELEVENLABS_BASE_URL = "https://api.elevenlabs.io/v1";
// OpenAI's raw `pcm` format and ElevenLabs' `pcm_24000` are both 24 kHz mono 16-bit.
const RAW_PCM_FORMAT = { sampleRate: 24_000, channels: 1 } as const;

export interface SpeechRequest {
  readonly text: string;
  /** Neighbouring text lets ElevenLabs keep intonation consistent across pieces. */
  readonly previousText?: string | undefined;
  readonly nextText?: string | undefined;
  readonly signal: AbortSignal;
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
    const response = await speechFetch(
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
  const response = await speechFetch(
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
  const response = await speechFetch(`${ELEVENLABS_BASE_URL}/voices`, {
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

async function mapConcurrent<T, R>(
  items: readonly T[],
  limit: number,
  map: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = Array.from({ length: items.length });
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await map(items[index]!, index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * Speaks a whole assistant message as one WAV file. Long text is split and synthesized in
 * parallel, then joined, so seeking works across the entire message.
 */
export async function synthesizeMessageWav(
  provider: SpeechProviderConfig,
  markdown: string,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const text = markdownToSpeechText(markdown);
  if (!text) throw new Error("This message has nothing to read aloud.");
  const chunks = splitSpeechText(text, SPEECH_CHUNK_LENGTH);
  const pieces = await mapConcurrent(chunks, 3, (chunk, index) =>
    synthesizeSpeech(provider, {
      text: chunk,
      previousText: chunks[index - 1],
      nextText: chunks[index + 1],
      signal,
    }),
  );
  signal.throwIfAborted();
  return encodeWav(pieces);
}

/** A stable key for caching a message's audio per provider voice. */
export function speechCacheKeySource(provider: SpeechProviderConfig, markdown: string): string {
  return JSON.stringify([
    provider.kind,
    provider.baseUrl,
    provider.model,
    provider.voice,
    markdownToSpeechText(markdown),
  ]);
}

/**
 * Uploads a recording to the provider's speech-to-text endpoint and returns the text.
 * `file` is a Blob on the web; React Native passes its `{ uri, name, type }` file shape.
 */
export async function transcribeAudio(
  provider: SpeechProviderConfig,
  file: Blob,
  fileName: string,
  signal: AbortSignal,
): Promise<string> {
  const form = new FormData();
  form.append("file", file, fileName);
  const apiKey = provider.apiKey.trim();
  let url: string;
  let headers: Record<string, string>;
  if (provider.kind === "elevenlabs") {
    url = `${ELEVENLABS_BASE_URL}/speech-to-text`;
    headers = { "xi-api-key": apiKey };
    form.append("model_id", provider.transcriptionModel.trim());
  } else {
    const base =
      provider.kind === "openai-compatible" ? trimSlash(provider.baseUrl) : OPENAI_BASE_URL;
    url = `${base}/audio/transcriptions`;
    headers = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
    form.append("model", provider.transcriptionModel.trim());
    form.append("response_format", "json");
  }
  const response = await speechFetch(url, { method: "POST", headers, body: form, signal });
  if (!response.ok) {
    const error = await responseError(response, "Transcription");
    throw error;
  }
  const body = (await response.json()) as { text?: unknown };
  return typeof body.text === "string" ? body.text.trim() : "";
}
