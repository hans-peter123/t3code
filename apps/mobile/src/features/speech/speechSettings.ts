import {
  createSpeechSettingsStore,
  type SpeechSettings,
  type SpeechSettingsStore,
} from "@t3tools/client-runtime/speech";
import * as SecureStore from "expo-secure-store";
import { useSyncExternalStore } from "react";

export {
  activeSpeechProvider,
  OPENAI_VOICES,
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

const store: SpeechSettingsStore = createSpeechSettingsStore({
  read: () => SecureStore.getItemAsync(STORAGE_KEY),
  write: (value) => SecureStore.setItemAsync(STORAGE_KEY, value),
});

export const loadSpeechSettings = store.load;
export const updateSpeechSettings = store.update;
export const currentSpeechSettings = store.current;

export function useSpeechSettings(): SpeechSettings {
  return useSyncExternalStore(store.subscribe, store.current);
}
