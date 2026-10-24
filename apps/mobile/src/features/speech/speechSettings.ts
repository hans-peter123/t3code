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
  readonly model: string;
  readonly voice: string;
}

export interface SpeechSettings {
  readonly providers: readonly SpeechProviderConfig[];
  readonly activeProviderId: string | null;
  readonly playbackRate: number;
}

export const SPEECH_PROVIDER_KINDS: Record<
  SpeechProviderKind,
  {
    readonly label: string;
    readonly description: string;
    readonly defaultModel: string;
    readonly defaultVoice: string;
  }
> = {
  openai: {
    label: "OpenAI",
    description: "gpt-4o-mini-tts and tts-1 voices",
    defaultModel: "gpt-4o-mini-tts",
    defaultVoice: "coral",
  },
  elevenlabs: {
    label: "ElevenLabs",
    description: "Your ElevenLabs voices",
    defaultModel: "eleven_multilingual_v2",
    defaultVoice: "",
  },
  "openai-compatible": {
    label: "Custom server",
    description: "Any server with an OpenAI-compatible /audio/speech endpoint",
    defaultModel: "tts-1",
    defaultVoice: "alloy",
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
const DEFAULT_SETTINGS: SpeechSettings = { providers: [], activeProviderId: null, playbackRate: 1 };

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
          },
        ];
      })
    : [];
  const activeProviderId =
    typeof raw.activeProviderId === "string" &&
    providers.some((provider) => provider.id === raw.activeProviderId)
      ? raw.activeProviderId
      : (providers[0]?.id ?? null);
  const playbackRate =
    typeof raw.playbackRate === "number" &&
    (PLAYBACK_RATES as readonly number[]).includes(raw.playbackRate)
      ? raw.playbackRate
      : 1;
  return { providers, activeProviderId, playbackRate };
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

export function activeSpeechProvider(current: SpeechSettings): SpeechProviderConfig | null {
  return current.providers.find((provider) => provider.id === current.activeProviderId) ?? null;
}

/** Why a provider cannot speak yet, or null when it is ready. */
export function speechProviderProblem(provider: SpeechProviderConfig): string | null {
  if (provider.kind !== "openai-compatible" && !provider.apiKey.trim()) return "Add an API key.";
  if (provider.kind === "openai-compatible" && !provider.baseUrl.trim()) return "Add a server URL.";
  if (provider.kind === "elevenlabs" && !provider.voice.trim()) return "Choose a voice.";
  if (!provider.model.trim()) return "Add a model.";
  return null;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  void loadSpeechSettings();
  return () => listeners.delete(listener);
}

export function useSpeechSettings(): SpeechSettings {
  return useSyncExternalStore(subscribe, () => settings);
}
