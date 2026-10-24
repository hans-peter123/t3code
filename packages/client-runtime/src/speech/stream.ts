// @effect-diagnostics globalTimers:off - shared by React Native and the web, which use plain timers.
import { SpeechProviderError, synthesizeSpeech, type SpeechRequest } from "./providers.ts";
import type { SpeechProviderConfig } from "./settings.ts";
import { markdownToSpeechText, planSpeechChunks } from "./text.ts";
import { encodeWav, type PcmAudio } from "./wav.ts";

/** Kept under every provider's per-request limit (gpt-4o-mini-tts takes about 2000 tokens). */
export const SPEECH_CHUNK_LENGTH = 1500;
/**
 * The first request is short so audio starts fast; the second is mid-sized so the first part
 * plays long enough to cover it, even at 2x speed.
 */
export const SPEECH_LEAD_IN_LENGTHS = [400, 800] as const;

/** Splits a message into the texts to synthesize, in order. */
export function planMessageSpeech(markdown: string): string[] {
  const text = markdownToSpeechText(markdown);
  if (!text) throw new Error("This message has nothing to read aloud.");
  return planSpeechChunks(text, SPEECH_LEAD_IN_LENGTHS, SPEECH_CHUNK_LENGTH);
}

export type SpeechDelay = (ms: number, signal: AbortSignal) => Promise<void>;

export interface SpeechRetryOptions {
  /** Retries after the first attempt. */
  readonly retries?: number;
  readonly baseDelayMs?: number;
  /** Caps the exponential backoff and any `Retry-After` the provider asks for. */
  readonly maxDelayMs?: number;
  /** Injectable for tests. */
  readonly delay?: SpeechDelay;
}

const abortableDelay: SpeechDelay = (ms, signal) =>
  new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });

function isRetryable(error: unknown): error is SpeechProviderError {
  return error instanceof SpeechProviderError && (error.status === 429 || error.status >= 500);
}

/**
 * Runs one provider request, retrying rate limits (429) and server errors (5xx) with exponential
 * backoff, or after the provider's `Retry-After` when it sends one.
 */
export async function withSpeechRetry<T>(
  run: () => Promise<T>,
  signal: AbortSignal,
  options: SpeechRetryOptions = {},
): Promise<T> {
  const retries = options.retries ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 1000;
  const maxDelayMs = options.maxDelayMs ?? 30_000;
  const delay = options.delay ?? abortableDelay;
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      if (signal.aborted || attempt >= retries || !isRetryable(error)) throw error;
      await delay(Math.min(maxDelayMs, error.retryAfterMs ?? baseDelayMs * 2 ** attempt), signal);
    }
  }
}

export interface SpeechPartsOptions extends SpeechRetryOptions {
  readonly signal: AbortSignal;
  /** Called with each part as soon as it is ready, in order. */
  readonly onPart?: (audio: PcmAudio, index: number) => void;
  /** Injectable for tests. */
  readonly synthesize?: (
    provider: SpeechProviderConfig,
    request: SpeechRequest,
  ) => Promise<PcmAudio>;
}

/**
 * Synthesizes the chunks one request at a time, in order. Providers such as ElevenLabs cap
 * concurrent requests per account, so a message never has more than one in flight.
 */
export async function synthesizeSpeechParts(
  provider: SpeechProviderConfig,
  chunks: readonly string[],
  options: SpeechPartsOptions,
): Promise<PcmAudio[]> {
  const { signal } = options;
  const synthesize = options.synthesize ?? synthesizeSpeech;
  const parts: PcmAudio[] = [];
  for (const [index, text] of chunks.entries()) {
    signal.throwIfAborted();
    const audio = await withSpeechRetry(
      () =>
        synthesize(provider, {
          text,
          previousText: chunks[index - 1],
          nextText: chunks[index + 1],
          signal,
        }),
      signal,
      options,
    );
    parts.push(audio);
    options.onPart?.(audio, index);
  }
  return parts;
}

/** Speaks a whole assistant message as one WAV file. */
export async function synthesizeMessageWav(
  provider: SpeechProviderConfig,
  markdown: string,
  signal: AbortSignal,
): Promise<Uint8Array> {
  return encodeWav(await synthesizeSpeechParts(provider, planMessageSpeech(markdown), { signal }));
}
