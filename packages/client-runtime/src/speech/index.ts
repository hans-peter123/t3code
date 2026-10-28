export { markdownToSpeechText, planSpeechChunks, splitSpeechText } from "./text.ts";
export { languageSample, resolveDictationLocale } from "./language.ts";
export { encodeWav, parseWav, type PcmAudio, type PcmFormat } from "./wav.ts";
export {
  activeSpeechProvider,
  createSpeechSettingsStore,
  DEFAULT_SPEECH_SETTINGS,
  newSpeechProvider,
  OPENAI_VOICES,
  PLAYBACK_RATES,
  sanitizeSpeechSettings,
  stepPlaybackRate,
  SPEECH_PROVIDER_KINDS,
  speechProviderProblem,
  transcriptionProvider,
  transcriptionProviderProblem,
  withSpeechProviderAdded,
  withSpeechProviderRemoved,
  type SpeechProviderConfig,
  type SpeechProviderKind,
  type SpeechReadMode,
  type SpeechSettings,
  type SpeechSettingsStorage,
  type SpeechSettingsStore,
} from "./settings.ts";
export {
  describeTranscriptionTest,
  listElevenLabsVoices,
  silentWav,
  setSpeechFetch,
  parseRetryAfter,
  speechCacheKeySource,
  SpeechProviderError,
  synthesizeSpeech,
  transcribeAudio,
  type SpeechVoice,
} from "./providers.ts";
export {
  planMessageSpeech,
  SPEECH_CHUNK_LENGTH,
  SPEECH_LEAD_IN_LENGTHS,
  synthesizeMessageWav,
  synthesizeSpeechParts,
  withSpeechRetry,
  type SpeechDelay,
  type SpeechPartsOptions,
  type SpeechRetryOptions,
} from "./stream.ts";
export {
  locateSpeechTime,
  pcmDuration,
  speechPartStart,
  speechTimelineDuration,
  type SpeechTimelinePosition,
} from "./timeline.ts";
export {
  HANDS_FREE_COPY,
  HANDS_FREE_LISTEN_LIMIT_MS,
  HANDS_FREE_OFF,
  handsFreePressEvent,
  handsFreeReducer,
  type HandsFreeEffect,
  type HandsFreeEvent,
  type HandsFreePhase,
  type HandsFreeSpeech,
  type HandsFreeState,
  type HandsFreeStep,
  type HandsFreeUnsent,
} from "./handsFree.ts";
export {
  decideSpeak,
  requestedReadMode,
  resolveSpokenText,
  shownSpeechMode,
  type SpeakDecision,
  type SpokenText,
} from "./readMode.ts";
export { nextAutoRead, type AutoReadCursor, type AutoReadMessage } from "./autoRead.ts";
export {
  handsFreeSeedThreadFromShell,
  handsFreeThreadEvents,
  handsFreeThreadFromDetail,
  handsFreeThreadFromShell,
  handsFreeThreadRequest,
  handsFreeWorkingAfterSend,
  NO_THREADS_SEEN,
  type HandsFreeThreadRequest,
  type HandsFreeThreadSnapshot,
  type HandsFreeThreadsSeen,
} from "./handsFreeThreads.ts";
