export { markdownToSpeechText, splitSpeechText } from "./text.ts";
export { encodeWav, parseWav, type PcmAudio, type PcmFormat } from "./wav.ts";
export {
  activeSpeechProvider,
  createSpeechSettingsStore,
  DEFAULT_SPEECH_SETTINGS,
  OPENAI_VOICES,
  PLAYBACK_RATES,
  sanitizeSpeechSettings,
  SPEECH_PROVIDER_KINDS,
  speechProviderProblem,
  transcriptionProvider,
  transcriptionProviderProblem,
  type SpeechProviderConfig,
  type SpeechProviderKind,
  type SpeechSettings,
  type SpeechSettingsStorage,
  type SpeechSettingsStore,
} from "./settings.ts";
export {
  listElevenLabsVoices,
  setSpeechFetch,
  speechCacheKeySource,
  synthesizeMessageWav,
  synthesizeSpeech,
  transcribeAudio,
  type SpeechVoice,
} from "./providers.ts";
