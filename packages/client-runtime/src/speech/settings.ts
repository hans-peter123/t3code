// @effect-diagnostics globalConsole:off - a plain store shared by React Native and the web.
export type SpeechProviderKind = "openai" | "elevenlabs" | "openai-compatible";

/** "short" reads the server-written spoken summary of the thread; "full" reads the whole reply. */
export type SpeechReadMode = "short" | "full";

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
  /** Display name of a voice picked from the provider's list; absent for a typed voice ID. */
  readonly voiceName?: string;
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
  /** Reads each finished reply in the open thread aloud. */
  readonly autoRead: boolean;
  /** Double tap on a reply reads it aloud instead of selecting a word. */
  readonly doubleTapToRead: boolean;
  /** What a reply read aloud plays by default on this device. */
  readonly readMode: SpeechReadMode;
  /** BCP 47 locale dictation listens for; null follows the thread's language. */
  readonly dictationLanguage: string | null;
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

const PLAYBACK_RATE_STEP = 0.05;
const MIN_PLAYBACK_RATE = 0.75;
const MAX_PLAYBACK_RATE = 2;

/** Snaps to the nearest 0.05 step within the supported range. */
function clampPlaybackRate(rate: number): number {
  const steps = Math.round((rate - MIN_PLAYBACK_RATE) / PLAYBACK_RATE_STEP);
  const snapped = MIN_PLAYBACK_RATE + steps * PLAYBACK_RATE_STEP;
  return Math.round(Math.min(MAX_PLAYBACK_RATE, Math.max(MIN_PLAYBACK_RATE, snapped)) * 100) / 100;
}

export function stepPlaybackRate(rate: number, steps: number): number {
  return clampPlaybackRate(rate + steps * PLAYBACK_RATE_STEP);
}

export const PLAYBACK_RATES: readonly number[] = Array.from(
  { length: Math.round((MAX_PLAYBACK_RATE - MIN_PLAYBACK_RATE) / PLAYBACK_RATE_STEP) + 1 },
  (_, index) => clampPlaybackRate(MIN_PLAYBACK_RATE + index * PLAYBACK_RATE_STEP),
);

export const DEFAULT_SPEECH_SETTINGS: SpeechSettings = {
  providers: [],
  activeProviderId: null,
  transcriptionProviderId: null,
  playbackRate: 1,
  autoRead: false,
  doubleTapToRead: true,
  readMode: "short",
  dictationLanguage: null,
};

const LOCALE_PATTERN = /^[a-z]{2,3}(?:[-_][a-z0-9]{2,8})*$/i;

export function sanitizeSpeechSettings(value: unknown): SpeechSettings {
  if (typeof value !== "object" || value === null) return DEFAULT_SPEECH_SETTINGS;
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
            ...(typeof provider.voiceName === "string" ? { voiceName: provider.voiceName } : {}),
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
    typeof raw.playbackRate === "number" && Number.isFinite(raw.playbackRate)
      ? clampPlaybackRate(raw.playbackRate)
      : 1;
  return {
    providers,
    activeProviderId,
    transcriptionProviderId,
    playbackRate,
    autoRead: raw.autoRead === true,
    doubleTapToRead: raw.doubleTapToRead !== false,
    readMode: raw.readMode === "full" ? "full" : "short",
    dictationLanguage:
      typeof raw.dictationLanguage === "string" &&
      raw.dictationLanguage.length <= 35 &&
      LOCALE_PATTERN.test(raw.dictationLanguage)
        ? raw.dictationLanguage
        : null,
  };
}

/** A provider of the given kind with its default models and voice. */
export function newSpeechProvider(
  id: string,
  kind: SpeechProviderKind,
  patch: Partial<Omit<SpeechProviderConfig, "id" | "kind">> = {},
): SpeechProviderConfig {
  const defaults = SPEECH_PROVIDER_KINDS[kind];
  return {
    id,
    kind,
    name: "",
    apiKey: "",
    baseUrl: "",
    model: defaults.defaultModel,
    voice: defaults.defaultVoice,
    transcriptionModel: defaults.defaultTranscriptionModel,
    ...patch,
  };
}

export function withSpeechProviderAdded(
  current: SpeechSettings,
  provider: SpeechProviderConfig,
): SpeechSettings {
  return {
    ...current,
    providers: [...current.providers, provider],
    // The first provider also turns read aloud on; later ones are picked explicitly.
    activeProviderId: current.providers.length === 0 ? provider.id : current.activeProviderId,
  };
}

/** Removing a provider turns its jobs off rather than handing them to another provider. */
export function withSpeechProviderRemoved(current: SpeechSettings, id: string): SpeechSettings {
  return {
    ...current,
    providers: current.providers.filter((provider) => provider.id !== id),
    activeProviderId: current.activeProviderId === id ? null : current.activeProviderId,
    transcriptionProviderId:
      current.transcriptionProviderId === id ? null : current.transcriptionProviderId,
  };
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

/** Where a client keeps the settings JSON; it holds API keys, so prefer secure storage. */
export interface SpeechSettingsStorage {
  readonly read: () => Promise<string | null>;
  readonly write: (value: string) => Promise<void>;
}

export interface SpeechSettingsStore {
  /** Resolves to the current settings, reading storage only once. */
  readonly load: () => Promise<SpeechSettings>;
  readonly update: (transform: (current: SpeechSettings) => SpeechSettings) => Promise<void>;
  /** The settings as they stand now; defaults until storage has been read. */
  readonly current: () => SpeechSettings;
  readonly subscribe: (listener: () => void) => () => void;
}

export function createSpeechSettingsStore(storage: SpeechSettingsStorage): SpeechSettingsStore {
  let settings = DEFAULT_SPEECH_SETTINGS;
  let loaded: Promise<void> | null = null;
  let writes: Promise<void> = Promise.resolve();
  const listeners = new Set<() => void>();
  const emit = () => {
    for (const listener of listeners) listener();
  };
  const load = async () => {
    loaded ??= storage
      .read()
      .then((raw) => {
        settings = raw ? sanitizeSpeechSettings(JSON.parse(raw)) : DEFAULT_SPEECH_SETTINGS;
        emit();
      })
      .catch((error: unknown) => {
        console.warn("[speech] could not load settings", error);
      });
    await loaded;
    // Not the value from the first read: later edits replace `settings`.
    return settings;
  };
  return {
    load,
    update: async (transform) => {
      await load();
      settings = sanitizeSpeechSettings(transform(settings));
      emit();
      // One write at a time, each storing the newest settings, so a slow write never lands last.
      const write = writes.then(() => storage.write(JSON.stringify(settings)));
      writes = write.catch((error: unknown) => {
        console.warn("[speech] could not save settings", error);
      });
      await writes;
    },
    current: () => settings,
    subscribe: (listener) => {
      listeners.add(listener);
      void load();
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
