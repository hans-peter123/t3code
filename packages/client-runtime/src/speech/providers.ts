// @effect-diagnostics globalFetch:off - shared by React Native and the web, which call plain fetch.
// @effect-diagnostics globalDate:off - Retry-After dates are compared with the wall clock.
import { localeLanguage } from "./language.ts";
import { OPENAI_VOICES, type SpeechProviderConfig, type SpeechProviderKind } from "./settings.ts";
import { markdownToSpeechText } from "./text.ts";
import { encodeWav, parseWav, type PcmAudio } from "./wav.ts";

type SpeechFetch = (url: string, init: RequestInit) => Promise<Response>;

let speechFetch: SpeechFetch = (url, init) => fetch(url, init);

/** Lets a client route provider requests elsewhere, e.g. the desktop main process without CORS. */
export function setSpeechFetch(impl: SpeechFetch): void {
  speechFetch = impl;
}

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

/** A provider answered with an error status; 429 and 5xx are worth retrying. */
export class SpeechProviderError extends Error {
  readonly status: number;
  /** The provider's `Retry-After`, when it sent one. */
  readonly retryAfterMs: number | undefined;

  constructor(message: string, status: number, retryAfterMs?: number) {
    super(message);
    this.name = "SpeechProviderError";
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

/** Reads `Retry-After` as either seconds or an HTTP date. */
export function parseRetryAfter(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value.trim());
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

async function responseError(response: Response, provider: string): Promise<SpeechProviderError> {
  let detail = "";
  try {
    const text = (await response.text()).trim();
    try {
      const body = JSON.parse(text) as {
        error?: { message?: string } | string;
        detail?: { message?: string } | string;
        message?: string;
      };
      const candidate = body.error ?? body.detail ?? body.message;
      detail = typeof candidate === "string" ? candidate : (candidate?.message ?? text);
    } catch {
      detail = text;
    }
  } catch {}
  return new SpeechProviderError(
    `${provider} returned ${response.status}${detail ? `: ${detail}` : ""}`.slice(0, 400),
    response.status,
    parseRetryAfter(response.headers.get("retry-after")),
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

/** The language a custom server is asked to speak; empty lets the model detect it. */
function spokenLanguage(provider: SpeechProviderConfig): string {
  const language = provider.language?.trim() ?? "";
  return language === "auto" ? "" : language;
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
        ...(custom && spokenLanguage(provider) ? { language: spokenLanguage(provider) } : {}),
        // Self-hosted servers vary in raw PCM support; WAV carries its own format.
        response_format: custom ? "wav" : "pcm",
      }),
      signal: request.signal,
    },
  );
  if (!response.ok) throw await responseError(response, custom ? "The voice server" : "OpenAI");
  return custom ? parseWav(await bytes(response)) : rawPcm(await bytes(response));
}

/** A voice or model a provider offers. */
export interface SpeechChoice {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
}

/** The provider setting a list of choices fills in; only custom servers list languages. */
export type SpeechChoiceField = "voice" | "model" | "transcriptionModel" | "language";

const plainChoices = (ids: readonly string[]): SpeechChoice[] =>
  ids.map((id) => ({ id, name: id }));

// OpenAI's /models has no capability flags, and ElevenLabs' lists only text-to-speech models.
const FIXED_CHOICES: Partial<
  Record<SpeechProviderKind, Partial<Record<SpeechChoiceField, readonly SpeechChoice[]>>>
> = {
  openai: {
    voice: OPENAI_VOICES.map((voice) => ({
      id: voice,
      name: voice[0]!.toUpperCase() + voice.slice(1),
    })),
    model: plainChoices(["gpt-4o-mini-tts", "tts-1", "tts-1-hd"]),
    transcriptionModel: plainChoices(["gpt-4o-transcribe", "gpt-4o-mini-transcribe", "whisper-1"]),
  },
  elevenlabs: {
    transcriptionModel: plainChoices(["scribe_v1", "scribe_v2"]),
  },
};

/** Choices known without asking the provider; null when they come from its API. */
export function fixedSpeechChoices(
  provider: SpeechProviderConfig,
  field: SpeechChoiceField,
): readonly SpeechChoice[] | null {
  return FIXED_CHOICES[provider.kind]?.[field] ?? null;
}

type ListedItem = Readonly<Record<string, unknown>>;

function listedItems(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function text(item: ListedItem, key: string): string | null {
  const value = item[key];
  return typeof value === "string" && value.trim() ? value : null;
}

/** OpenAI-compatible servers answer `{ data: [{ id }] }`, or strings and objects under `voices`. */
function serverItems(body: unknown): ListedItem[] {
  if (typeof body !== "object" || body === null) return [];
  const { data, voices } = body as ListedItem;
  return [...listedItems(data), ...listedItems(voices)].flatMap((item): ListedItem[] => {
    if (typeof item === "string") return item.trim() ? [{ id: item }] : [];
    return typeof item === "object" && item !== null ? [item as ListedItem] : [];
  });
}

function serverChoice(entry: ListedItem): SpeechChoice[] {
  const id =
    text(entry, "id") ?? text(entry, "voice_id") ?? text(entry, "code") ?? text(entry, "name");
  if (!id) return [];
  const description = text(entry, "description");
  return [{ id, name: text(entry, "name") ?? id, ...(description ? { description } : {}) }];
}

function servesModel(item: ListedItem, model: string): boolean {
  return (
    item.id === model ||
    (Array.isArray(item.models) && item.models.includes(model)) ||
    (Array.isArray(item.aliases) && item.aliases.includes(model))
  );
}

/** The chosen model's languages, or every model's when the server does not name the model. */
function languageChoices(models: readonly ListedItem[], model: string): SpeechChoice[] {
  const speaking = models.filter(
    (item) => item.task === undefined || item.task === "text-to-speech",
  );
  const chosen = speaking.filter((item) => servesModel(item, model));
  const seen = new Set<string>();
  return (chosen.length > 0 ? chosen : speaking)
    .flatMap((item) => serverItems({ data: item.languages }))
    .flatMap(serverChoice)
    .filter((choice) => !seen.has(choice.id) && seen.add(choice.id));
}

function nativeLanguage(item: ListedItem): string | null {
  const native = item.native_language;
  return typeof native === "object" && native !== null ? text(native as ListedItem, "code") : null;
}

const MODEL_TASKS = { model: "text-to-speech", transcriptionModel: "speech-to-text" } as const;

/** The voices or models a provider offers for one setting. */
export async function listSpeechChoices(
  provider: SpeechProviderConfig,
  field: SpeechChoiceField,
  signal?: AbortSignal,
): Promise<readonly SpeechChoice[]> {
  const fixed = fixedSpeechChoices(provider, field);
  if (fixed) return fixed;
  if (field === "language" && provider.kind !== "openai-compatible") return [];
  const init = signal ? { signal } : {};

  if (provider.kind === "elevenlabs") {
    const voices = field === "voice";
    const response = await speechFetch(`${ELEVENLABS_BASE_URL}/${voices ? "voices" : "models"}`, {
      headers: { "xi-api-key": provider.apiKey.trim() },
      ...init,
    });
    if (!response.ok) throw await responseError(response, "ElevenLabs");
    const body = (await response.json()) as unknown;
    if (voices) {
      const list = typeof body === "object" && body !== null ? (body as ListedItem).voices : null;
      return listedItems(list).flatMap((item): SpeechChoice[] => {
        const entry = (typeof item === "object" && item !== null ? item : {}) as ListedItem;
        const id = text(entry, "voice_id");
        return id ? [{ id, name: text(entry, "name") ?? id }] : [];
      });
    }
    return listedItems(body).flatMap((item): SpeechChoice[] => {
      const entry = (typeof item === "object" && item !== null ? item : {}) as ListedItem;
      const id = text(entry, "model_id");
      return id && entry.can_do_text_to_speech !== false
        ? [{ id, name: text(entry, "name") ?? id }]
        : [];
    });
  }

  const apiKey = provider.apiKey.trim();
  const fetchList = (path: string) =>
    speechFetch(`${trimSlash(provider.baseUrl)}${path}`, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      ...init,
    });
  const missing = (response: Response) => response.status === 404 || response.status === 405;
  let response = await fetchList(field === "voice" ? "/audio/voices" : "/audio/models");
  // Servers without /audio/models list everything they run, speech models included, at /models.
  if ((field === "model" || field === "transcriptionModel") && missing(response)) {
    response = await fetchList("/models");
  }
  if (missing(response)) {
    throw new SpeechProviderError(
      `This server does not list its ${field === "voice" ? "voices" : field === "language" ? "languages" : "models"}.`,
      response.status,
    );
  }
  if (!response.ok) throw await responseError(response, "The voice server");
  const items = serverItems(await response.json());

  const model = provider.model.trim();
  if (field === "language") return languageChoices(items, model);
  if (field !== "voice") {
    return items
      .filter((item) => text(item, "task") === null || item.task === MODEL_TASKS[field])
      .flatMap(serverChoice);
  }
  // A server that names each voice's models gets the voices of the chosen model only.
  const forModel = items.filter((item) => servesModel(item, model));
  // Voices native to the chosen language sound most natural; another name for a voice goes last.
  const language = spokenLanguage(provider);
  const rank = (item: ListedItem) =>
    (item.is_alias === true ? 2 : 0) + (language && nativeLanguage(item) !== language ? 1 : 0);
  return (forModel.length > 0 ? forModel : items)
    .map((item, index) => ({ item, index }))
    .sort((a, b) => rank(a.item) - rank(b.item) || a.index - b.index)
    .flatMap(({ item }) => serverChoice(item));
}

/** A stable key for caching a message's audio per provider voice. */
export function speechCacheKeySource(provider: SpeechProviderConfig, markdown: string): string {
  return JSON.stringify([
    provider.kind,
    provider.baseUrl,
    provider.model,
    provider.voice,
    provider.language ?? "",
    markdownToSpeechText(markdown),
  ]);
}

// Apple names these languages differently from Whisper's ISO 639-1 list.
const TRANSCRIPTION_LANGUAGE_ALIASES: Readonly<Record<string, string>> = {
  nb: "no",
  nn: "no",
  fil: "tl",
};

/**
 * Uploads a recording to the provider's speech-to-text endpoint and returns the text.
 * `file` is a Blob on the web; React Native passes its `{ uri, name, type }` file shape.
 * `language` is a locale or language tag; providers get its ISO 639-1 language. A provider that
 * rejects the language is asked once more without it, so it detects the language itself.
 */
export async function transcribeAudio(
  provider: SpeechProviderConfig,
  file: Blob,
  fileName: string,
  signal: AbortSignal,
  language?: string | null,
): Promise<string> {
  const base = language ? localeLanguage(language) : null;
  const languageCode = base ? (TRANSCRIPTION_LANGUAGE_ALIASES[base] ?? base) : null;
  const apiKey = provider.apiKey.trim();
  const elevenLabs = provider.kind === "elevenlabs";
  const url = elevenLabs
    ? `${ELEVENLABS_BASE_URL}/speech-to-text`
    : `${provider.kind === "openai-compatible" ? trimSlash(provider.baseUrl) : OPENAI_BASE_URL}/audio/transcriptions`;
  const headers: Record<string, string> = elevenLabs
    ? { "xi-api-key": apiKey }
    : apiKey
      ? { Authorization: `Bearer ${apiKey}` }
      : {};
  const request = (code: string | null) => {
    const form = new FormData();
    form.append("file", file, fileName);
    if (elevenLabs) {
      form.append("model_id", provider.transcriptionModel.trim());
      if (code) form.append("language_code", code);
    } else {
      form.append("model", provider.transcriptionModel.trim());
      form.append("response_format", "json");
      if (code) form.append("language", code);
    }
    return speechFetch(url, { method: "POST", headers, body: form, signal });
  };
  let response = await request(languageCode);
  if (languageCode && (response.status === 400 || response.status === 422)) {
    response = await request(null);
  }
  if (!response.ok) {
    throw await responseError(response, `Transcription at ${new URL(url).host}`);
  }
  const body = (await response.json()) as { text?: unknown };
  return typeof body.text === "string" ? body.text.trim() : "";
}

/** One second of silence as WAV: enough for a provider to prove URL, key, and model work. */
export function silentWav(): Uint8Array {
  return encodeWav([
    { format: { sampleRate: 16_000, channels: 1 }, samples: new Uint8Array(32_000) },
  ]);
}

/** A readable report of a test transcription, for the settings "Test dictation" action. */
export function describeTranscriptionTest(result: PromiseSettledResult<string>): string {
  if (result.status === "fulfilled") {
    return result.value
      ? `Works. The server answered: "${result.value}" (Whisper models often invent a short phrase for the silent test audio.)`
      : "The server answered. The test audio is silent, so an empty transcript is expected.";
  }
  const error = result.reason;
  const message = error instanceof Error ? error.message : String(error);
  const cause =
    error instanceof Error && error.cause instanceof Error ? `\n${error.cause.message}` : "";
  return `${message}${cause}`;
}
