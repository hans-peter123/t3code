import {
  createSpeechSettingsStore,
  newSpeechProvider,
  sanitizeSpeechSettings,
  type SpeechProviderConfig,
  type SpeechSettings,
  type SpeechSettingsStore,
} from "@t3tools/client-runtime/speech";
import * as SecureStore from "expo-secure-store";
import { useSyncExternalStore } from "react";

export {
  activeSpeechProvider,
  PLAYBACK_RATES,
  SPEECH_PROVIDER_KINDS,
  speechProviderProblem,
  stepPlaybackRate,
  transcriptionProvider,
  transcriptionProviderProblem,
  type SpeechProviderConfig,
  type SpeechProviderKind,
  type SpeechReadMode,
  type SpeechSettings,
} from "@t3tools/client-runtime/speech";

// Keychain keeps API keys off the plain preferences database.
const STORAGE_KEY = "t3code.speech.settings";

const env = (value: string | undefined) => value?.trim() ?? "";

/**
 * Providers a personal build bakes in from `EXPO_PUBLIC_T3_SPEECH_*` (set in `.env.local`, never
 * committed). They are written over the stored ones on every launch and stay the active choice.
 */
const BUILT_IN_PROVIDERS: readonly SpeechProviderConfig[] = [
  env(process.env.EXPO_PUBLIC_T3_SPEECH_TTS_URL)
    ? newSpeechProvider("built-in-read-aloud", "openai-compatible", {
        name: "Read aloud (built in)",
        baseUrl: env(process.env.EXPO_PUBLIC_T3_SPEECH_TTS_URL),
        apiKey: env(process.env.EXPO_PUBLIC_T3_SPEECH_TTS_KEY),
        voice: env(process.env.EXPO_PUBLIC_T3_SPEECH_TTS_VOICE) || "house",
      })
    : null,
  env(process.env.EXPO_PUBLIC_T3_SPEECH_STT_URL)
    ? newSpeechProvider("built-in-dictation", "openai-compatible", {
        name: "Dictation (built in)",
        baseUrl: env(process.env.EXPO_PUBLIC_T3_SPEECH_STT_URL),
        apiKey: env(process.env.EXPO_PUBLIC_T3_SPEECH_STT_KEY),
        transcriptionModel: env(process.env.EXPO_PUBLIC_T3_SPEECH_STT_MODEL) || "whisper-1",
      })
    : null,
].filter((provider): provider is SpeechProviderConfig => provider !== null);

function withBuiltInProviders(settings: SpeechSettings): SpeechSettings {
  if (BUILT_IN_PROVIDERS.length === 0) return settings;
  const ids = new Set(BUILT_IN_PROVIDERS.map((provider) => provider.id));
  const has = (id: string) => ids.has(id);
  return {
    ...settings,
    providers: [
      ...BUILT_IN_PROVIDERS,
      ...settings.providers.filter((provider) => !has(provider.id)),
    ],
    activeProviderId: has("built-in-read-aloud")
      ? "built-in-read-aloud"
      : settings.activeProviderId,
    transcriptionProviderId: has("built-in-dictation")
      ? "built-in-dictation"
      : settings.transcriptionProviderId,
  };
}

const store: SpeechSettingsStore = createSpeechSettingsStore({
  read: async () => {
    const raw = await SecureStore.getItemAsync(STORAGE_KEY);
    if (BUILT_IN_PROVIDERS.length === 0) return raw;
    const stored = sanitizeSpeechSettings(raw ? JSON.parse(raw) : {});
    return JSON.stringify(withBuiltInProviders(stored));
  },
  write: (value) => SecureStore.setItemAsync(STORAGE_KEY, value),
});

export const loadSpeechSettings = store.load;
export const updateSpeechSettings = store.update;
export const currentSpeechSettings = store.current;

export function useSpeechSettings(): SpeechSettings {
  return useSyncExternalStore(store.subscribe, store.current);
}
