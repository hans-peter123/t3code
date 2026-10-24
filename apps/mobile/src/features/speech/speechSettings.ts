import * as SecureStore from "expo-secure-store";
import { useSyncExternalStore } from "react";

export type SpeechProviderKind = "openai" | "elevenlabs" | "openai-compatible";

export interface SpeechProviderConfig {
  readonly id: string;
  readonly kind: SpeechProviderKind;
  readonly name: string;
  readonly apiKey: string;
  /** Only used by OpenAI-compatible servers, e.g. `http://my-host:8880/v1`. */
  readonly baseUrl: string;
  /** Text-to-speech model. */
  readonly model: string;
  readonly voice: string;
  /** Speech-to-text model used for dictation. */
  readonly transcriptionModel: string;
}

export interface SpeechSettings {
  readonly providers: readonly SpeechProviderConfig[];
  /** Reads messages aloud; null turns read aloud off. */
  readonly activeProviderId: string | null;
  /** Transcribes dictation; null keeps Apple's on-device recognition. */
  readonly transcriptionProviderId: string | null;
  readonly playbackRate: number;
}

export const SPEECH_PROVIDER_KINDS: Record<
  SpeechProviderKind,
  {
    readonly label: string;
    readonly description: string;
    readonly defaultModel: string;
    readonly defaultVoice: string;
    readonly defaultTranscriptionModel: string;
  }
> = {
  openai: {
    label: "OpenAI",
    description: "OpenAI voices and transcription",
    defaultModel: "gpt-4o-mini-tts",
    defaultVoice: "coral",
    defaultTranscriptionModel: "gpt-4o-transcribe",
  },
  elevenlabs: {
    label: "ElevenLabs",
    description: "Your ElevenLabs voices and Scribe",
    defaultModel: "eleven_multilingual_v2",
    defaultVoice: "",
    defaultTranscriptionModel: "scribe_v1",
  },
  "openai-compatible": {
    label: "Custom server",
    description: "Any server with OpenAI-compatible /audio endpoints",
    defaultModel: "tts-1",
    defaultVoice: "alloy",
    defaultTranscriptionModel: "whisper-1",
  },
};

export const OPENAI_VOICES = [
  "alloy",
  "ash",
  "ballad",
  "coral",
  "echo",
  "fable",
  "nova",
  "onyx",
  "sage",
  "shimmer",
  "verse",
] as const;

export const PLAYBACK_RATES = [1, 1.25, 1.5, 1.75, 2] as const;

// Keychain keeps API keys off the plain preferences database.
const STORAGE_KEY = "t3code.speech.settings";
const DEFAULT_SETTINGS: SpeechSettings = {
  providers: [],
  activeProviderId: null,
  transcriptionProviderId: null,
  playbackRate: 1,
};

let settings: SpeechSettings = DEFAULT_SETTINGS;
let loaded: Promise<void> | null = null;
const listeners = new Set<() => void>();

function sanitize(value: unknown): SpeechSettings {
  if (typeof value !== "object" || value === null) return DEFAULT_SETTINGS;
  const raw = value as Record<string, unknown>;
  const providers = Array.isArray(raw.providers)
    ? raw.providers.flatMap((entry): SpeechProviderConfig[] => {
        if (typeof entry !== "object" || entry === null) return [];
        const provider = entry as Record<string, unknown>;
        const kind = provider.kind;
        if (
          typeof provider.id !== "string" ||
          typeof kind !== "string" ||
          !(kind in SPEECH_PROVIDER_KINDS)
        ) {
          return [];
        }
        const text = (key: string) =>
          typeof provider[key] === "string" ? (provider[key] as string) : "";
        return [
          {
            id: provider.id,
            kind: kind as SpeechProviderKind,
            name: text("name"),
            apiKey: text("apiKey"),
            baseUrl: text("baseUrl"),
            model: text("model"),
            voice: text("voice"),
            // Providers saved before dictation existed get the kind's default.
            transcriptionModel:
              typeof provider.transcriptionModel === "string"
                ? provider.transcriptionModel
                : SPEECH_PROVIDER_KINDS[kind as SpeechProviderKind].defaultTranscriptionModel,
          },
        ];
      })
    : [];
  const knownProvider = (id: unknown): id is string =>
    typeof id === "string" && providers.some((provider) => provider.id === id);
  // An explicit null means "off"; a missing or removed provider falls back to the first one.
  const activeProviderId = knownProvider(raw.activeProviderId)
    ? raw.activeProviderId
    : raw.activeProviderId === null
      ? null
      : (providers[0]?.id ?? null);
  const transcriptionProviderId = knownProvider(raw.transcriptionProviderId)
    ? raw.transcriptionProviderId
    : null;
  const playbackRate =
    typeof raw.playbackRate === "number" &&
    (PLAYBACK_RATES as readonly number[]).includes(raw.playbackRate)
      ? raw.playbackRate
      : 1;
  return { providers, activeProviderId, transcriptionProviderId, playbackRate };
}

function emit() {
  for (const listener of listeners) listener();
}

/** Resolves to the current settings, reading the keychain only once. */
export async function loadSpeechSettings(): Promise<SpeechSettings> {
  loaded ??= SecureStore.getItemAsync(STORAGE_KEY)
    .then((raw) => {
      settings = raw ? sanitize(JSON.parse(raw)) : DEFAULT_SETTINGS;
      emit();
    })
    .catch((error: unknown) => {
      console.warn("[speech] could not load settings", error);
    });
  await loaded;
  // Not the value from the first read: later edits replace `settings`.
  return settings;
}

export async function updateSpeechSettings(
  transform: (current: SpeechSettings) => SpeechSettings,
): Promise<void> {
  await loadSpeechSettings();
  settings = sanitize(transform(settings));
  emit();
  await SecureStore.setItemAsync(STORAGE_KEY, JSON.stringify(settings));
}

/** The settings as they stand now; empty until the keychain has been read. */
export function currentSpeechSettings(): SpeechSettings {
  return settings;
}

export function activeSpeechProvider(current: SpeechSettings): SpeechProviderConfig | null {
  return current.providers.find((provider) => provider.id === current.activeProviderId) ?? null;
}

export function transcriptionProvider(current: SpeechSettings): SpeechProviderConfig | null {
  return (
    current.providers.find((provider) => provider.id === current.transcriptionProviderId) ?? null
  );
}

function connectionProblem(provider: SpeechProviderConfig): string | null {
  if (provider.kind !== "openai-compatible" && !provider.apiKey.trim()) return "Add an API key.";
  if (provider.kind === "openai-compatible" && !provider.baseUrl.trim()) return "Add a server URL.";
  return null;
}

/** Why a provider cannot speak yet, or null when it is ready. */
export function speechProviderProblem(provider: SpeechProviderConfig): string | null {
  const problem = connectionProblem(provider);
  if (problem) return problem;
  if (provider.kind === "elevenlabs" && !provider.voice.trim()) return "Choose a voice.";
  if (!provider.model.trim()) return "Add a speech model.";
  return null;
}

/** Why a provider cannot transcribe yet, or null when it is ready. */
export function transcriptionProviderProblem(provider: SpeechProviderConfig): string | null {
  return (
    connectionProblem(provider) ??
    (provider.transcriptionModel.trim() ? null : "Add a transcription model.")
  );
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  void loadSpeechSettings();
  return () => listeners.delete(listener);
}

export function useSpeechSettings(): SpeechSettings {
  return useSyncExternalStore(subscribe, () => settings);
}
