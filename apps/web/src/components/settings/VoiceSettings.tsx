import {
  describeTranscriptionTest,
  fixedSpeechChoices,
  listSpeechChoices,
  newSpeechProvider,
  silentWav,
  transcribeAudio,
  PLAYBACK_RATES,
  SPEECH_PROVIDER_KINDS,
  speechProviderProblem,
  speechProviderSite,
  transcriptionProviderProblem,
  withSpeechProviderAdded,
  withSpeechProviderRemoved,
  type SpeechChoice,
  type SpeechChoiceField,
  type SpeechProviderConfig,
  type SpeechProviderKind,
  type SpeechReadMode,
} from "@t3tools/client-runtime/speech";
import { faviconUrlForOrigin } from "@t3tools/shared/favicon";
import { ServerIcon } from "lucide-react";
import { useState } from "react";

import { setSpeechPlaybackRate, speakMessage, stopSpeech } from "../../speech/speechPlayback";
import { updateSpeechSettings, useSpeechSettings } from "../../speech/speechSettings";
import { Button } from "../ui/button";
import { DraftInput } from "../ui/draft-input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { toastManager } from "../ui/toast";
import { SecretInput } from "./SecretInput";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

const OFF = "off";
const READ_MODE_LABELS: Record<SpeechReadMode, string> = {
  short: "Short version",
  full: "Full message",
};
const SAMPLE_TEXT = "Hi! This is how T3 Code reads your messages aloud.";

function providerLabel(provider: SpeechProviderConfig): string {
  return provider.name.trim() || SPEECH_PROVIDER_KINDS[provider.kind].label;
}

function editProvider(id: string, patch: Partial<SpeechProviderConfig>) {
  void updateSpeechSettings((current) => ({
    ...current,
    providers: current.providers.map((provider) =>
      provider.id === id ? { ...provider, ...patch } : provider,
    ),
  }));
}

function addProvider(kind: SpeechProviderKind) {
  // @effect-diagnostics-next-line cryptoRandomUUID:off - a local settings id, not Effect code.
  const provider = newSpeechProvider(crypto.randomUUID(), kind);
  void updateSpeechSettings((current) => withSpeechProviderAdded(current, provider));
}

/** The provider's favicon, or a server icon when it fails or the host is private. */
function ProviderIcon(props: { readonly provider: SpeechProviderConfig }) {
  const source = faviconUrlForOrigin(speechProviderSite(props.provider), 64);
  const [failed, setFailed] = useState<string | null>(null);
  return source === null || failed === source ? (
    <ServerIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
  ) : (
    <img
      src={source}
      alt=""
      draggable={false}
      className="size-4 shrink-0 rounded-sm"
      onError={() => setFailed(source)}
    />
  );
}

function ProviderSelect(props: {
  readonly label: string;
  readonly offLabel: string;
  readonly value: string | null;
  readonly providers: readonly SpeechProviderConfig[];
  readonly problem: (provider: SpeechProviderConfig) => string | null;
  readonly onChange: (id: string | null) => void;
}) {
  const selected = props.providers.find((provider) => provider.id === props.value);
  return (
    <Select
      value={props.value ?? OFF}
      onValueChange={(value) => props.onChange(value === OFF || value === null ? null : value)}
    >
      <SelectTrigger size="sm" className="w-full sm:w-56" aria-label={props.label}>
        <SelectValue>
          {selected ? (
            <span className="flex items-center gap-2">
              <ProviderIcon provider={selected} />
              {providerLabel(selected)}
            </span>
          ) : (
            props.offLabel
          )}
        </SelectValue>
      </SelectTrigger>
      <SelectPopup align="end" alignItemWithTrigger={false}>
        <SelectItem hideIndicator value={OFF}>
          {props.offLabel}
        </SelectItem>
        {props.providers.map((provider) => {
          const problem = props.problem(provider);
          return (
            <SelectItem key={provider.id} hideIndicator value={provider.id}>
              <span className="flex items-center gap-2">
                <ProviderIcon provider={provider} />
                {providerLabel(provider)}
                {problem ? ` (${problem.replace(/\.$/, "").toLowerCase()})` : ""}
              </span>
            </SelectItem>
          );
        })}
      </SelectPopup>
    </Select>
  );
}

function TextField(props: {
  readonly label: string;
  readonly value: string;
  readonly placeholder?: string;
  readonly onCommit: (value: string) => void;
}) {
  return (
    <label className="grid gap-1 text-sm">
      <span className="text-muted-foreground text-xs">{props.label}</span>
      <DraftInput
        size="sm"
        value={props.value}
        placeholder={props.placeholder}
        spellCheck={false}
        autoComplete="off"
        onCommit={(next) => props.onCommit(next.trim())}
      />
    </label>
  );
}

type ChoiceList =
  | { readonly status: "loading" }
  | { readonly status: "loaded"; readonly choices: readonly SpeechChoice[] }
  | { readonly status: "failed"; readonly message: string };

/** A typed value with a list of what the provider offers, fetched when the list first opens. */
function ChoiceField(props: {
  readonly provider: SpeechProviderConfig;
  readonly field: SpeechChoiceField;
  readonly label: string;
  readonly placeholder: string;
}) {
  const { provider, field } = props;
  const fixed = fixedSpeechChoices(provider, field);
  // What the provider is asked: voices and languages depend on the model, voice order on the language.
  const source = [
    provider.apiKey,
    provider.baseUrl,
    field === "voice" || field === "language" ? provider.model : "",
    field === "voice" ? (provider.language ?? "") : "",
  ].join("\n");
  const [fetched, setFetched] = useState<{ source: string; list: ChoiceList } | null>(null);
  const list: ChoiceList | null = fixed
    ? { status: "loaded", choices: fixed }
    : fetched?.source === source
      ? fetched.list
      : null;
  const value = provider[field] ?? "";
  const picked =
    list?.status === "loaded" ? list.choices.find((choice) => choice.id === value) : undefined;
  const pickedName = picked?.name ?? (field === "voice" ? provider.voiceName : undefined);
  const unavailable =
    !fixed && (provider.kind === "elevenlabs" ? !provider.apiKey.trim() : !provider.baseUrl.trim());

  const load = () => {
    setFetched({ source, list: { status: "loading" } });
    listSpeechChoices(provider, field, AbortSignal.timeout(20_000)).then(
      (choices) => setFetched({ source, list: { status: "loaded", choices } }),
      (error: unknown) =>
        setFetched({
          source,
          list: {
            status: "failed",
            message: error instanceof Error ? error.message : "Try again.",
          },
        }),
    );
  };

  const commit = (next: string, name?: string) =>
    editProvider(
      provider.id,
      field === "voice"
        ? { voice: next, voiceName: name ?? "" }
        : field === "model"
          ? { model: next }
          : field === "language"
            ? { language: next }
            : { transcriptionModel: next },
    );

  return (
    <div className="grid gap-1 text-sm">
      <span className="text-muted-foreground text-xs">{props.label}</span>
      <div className="flex gap-2">
        <DraftInput
          size="sm"
          value={value}
          placeholder={props.placeholder}
          spellCheck={false}
          autoComplete="off"
          aria-label={props.label}
          onCommit={(next) => commit(next.trim())}
        />
        <Select
          value={value}
          disabled={unavailable}
          onOpenChange={(open) => {
            if (open && (list === null || list.status === "failed")) load();
          }}
          onValueChange={(next) => {
            if (typeof next !== "string" || list?.status !== "loaded") return;
            commit(next, list.choices.find((choice) => choice.id === next)?.name);
          }}
        >
          <SelectTrigger size="sm" className="w-32 shrink-0" aria-label={`Choose ${props.label}`}>
            <SelectValue>{pickedName && pickedName !== value ? pickedName : "Choose"}</SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            {list === null || list.status === "loading" ? (
              <SelectItem hideIndicator disabled value="">
                Loading…
              </SelectItem>
            ) : list.status === "failed" ? (
              <SelectItem hideIndicator disabled value="">
                {list.message}
              </SelectItem>
            ) : list.choices.length === 0 ? (
              <SelectItem hideIndicator disabled value="">
                Nothing listed
              </SelectItem>
            ) : (
              list.choices.map((choice) => (
                <SelectItem key={choice.id} hideIndicator value={choice.id}>
                  <span className="grid">
                    {choice.name}
                    {choice.description ? (
                      <span className="text-muted-foreground text-xs">{choice.description}</span>
                    ) : null}
                  </span>
                </SelectItem>
              ))
            )}
          </SelectPopup>
        </Select>
      </div>
    </div>
  );
}

function ProviderCard(props: { readonly provider: SpeechProviderConfig }) {
  const { provider } = props;
  const kind = SPEECH_PROVIDER_KINDS[provider.kind];
  const [busy, setBusy] = useState<"sample" | "dictation" | null>(null);
  const [dictationReport, setDictationReport] = useState<string | null>(null);
  const speechProblem = speechProviderProblem(provider);
  const transcriptionProblem = transcriptionProviderProblem(provider);

  const report = (title: string, error: unknown) =>
    toastManager.add({
      type: "error",
      title,
      description: error instanceof Error ? error.message : "Try again.",
    });

  return (
    <div className="grid gap-3 border-border/60 border-t px-4 py-4 first:border-t-0">
      <div className="flex items-center justify-between gap-2">
        <p className="flex items-center gap-2 font-medium text-sm">
          <ProviderIcon provider={provider} />
          {providerLabel(provider)}
          {provider.name.trim() ? (
            <span className="ml-2 text-muted-foreground text-xs">{kind.label}</span>
          ) : null}
        </p>
        <div className="flex gap-2">
          <Button
            size="xs"
            variant="outline"
            disabled={speechProblem !== null || busy !== null}
            onClick={() => {
              setBusy("sample");
              speakMessage({
                messageId: `sample:${provider.id}`,
                provider,
                markdown: SAMPLE_TEXT,
                title: "Voice sample",
              })
                .catch((error: unknown) => report("Could not play the sample", error))
                .finally(() => setBusy(null));
            }}
          >
            Play sample
          </Button>
          <Button
            size="xs"
            variant="outline"
            disabled={transcriptionProblem !== null || busy !== null}
            onClick={() => {
              setBusy("dictation");
              setDictationReport(null);
              const wav = new Blob([silentWav() as Uint8Array<ArrayBuffer>], { type: "audio/wav" });
              void Promise.allSettled([
                transcribeAudio(provider, wav, "dictation-test.wav", AbortSignal.timeout(60_000)),
              ])
                .then(([result]) => setDictationReport(describeTranscriptionTest(result!)))
                .finally(() => setBusy(null));
            }}
          >
            Test dictation
          </Button>
          <Button
            size="xs"
            variant="destructive-outline"
            onClick={() => {
              stopSpeech();
              void updateSpeechSettings((current) =>
                withSpeechProviderRemoved(current, provider.id),
              );
            }}
          >
            Remove
          </Button>
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <TextField
          label="Name"
          value={provider.name}
          placeholder={kind.label}
          onCommit={(name) => editProvider(provider.id, { name })}
        />
        {provider.kind === "openai-compatible" ? (
          <TextField
            label="Server URL"
            value={provider.baseUrl}
            placeholder="https://my-server/v1"
            onCommit={(baseUrl) => editProvider(provider.id, { baseUrl })}
          />
        ) : null}
        <label className="grid gap-1 text-sm">
          <span className="text-muted-foreground text-xs">
            {provider.kind === "openai-compatible" ? "API key (optional)" : "API key"}
          </span>
          <SecretInput
            size="sm"
            configured={provider.apiKey.length > 0}
            value=""
            onCommit={(apiKey) => editProvider(provider.id, { apiKey: apiKey.trim() })}
          />
        </label>
        <ChoiceField
          provider={provider}
          field="model"
          label="Speech model (read aloud)"
          placeholder={kind.defaultModel}
        />
        {provider.kind === "openai-compatible" ? (
          <ChoiceField
            provider={provider}
            field="language"
            label="Language (read aloud)"
            placeholder="auto"
          />
        ) : null}
        <ChoiceField
          provider={provider}
          field="transcriptionModel"
          label="Transcription model (dictation)"
          placeholder={kind.defaultTranscriptionModel}
        />
        <ChoiceField
          provider={provider}
          field="voice"
          label={provider.kind === "elevenlabs" ? "Voice ID" : "Voice"}
          placeholder={kind.defaultVoice || "Voice ID"}
        />
      </div>
      {speechProblem ? (
        <p className="text-muted-foreground text-xs">Read aloud: {speechProblem}</p>
      ) : null}
      {transcriptionProblem ? (
        <p className="text-muted-foreground text-xs">Dictation: {transcriptionProblem}</p>
      ) : null}
      {dictationReport ? (
        <p className="whitespace-pre-wrap rounded-md bg-muted px-3 py-2 font-mono text-xs">
          Dictation test: {dictationReport}
        </p>
      ) : null}
    </div>
  );
}

export function VoiceSettingsPanel() {
  const settings = useSpeechSettings();

  return (
    <SettingsPageContainer>
      <SettingsSection title="Voice">
        <SettingsRow
          {...searchableSetting("voice-read-aloud")}
          description="Adds a read aloud button to assistant messages. Media keys and Now Playing control playback."
          control={
            <ProviderSelect
              label="Read aloud with"
              offLabel="Off"
              value={settings.activeProviderId}
              providers={settings.providers}
              problem={speechProviderProblem}
              onChange={(activeProviderId) =>
                void updateSpeechSettings((current) => ({ ...current, activeProviderId }))
              }
            />
          }
        />
        <SettingsRow
          {...searchableSetting("voice-read-mode")}
          description="The short version is spoken from the whole thread: where things stand, what was decided, and what needs you."
          control={
            <Select
              value={settings.readMode}
              onValueChange={(value) => {
                if (value === "short" || value === "full") {
                  void updateSpeechSettings((current) => ({ ...current, readMode: value }));
                }
              }}
            >
              <SelectTrigger size="sm" className="w-full sm:w-56" aria-label="Read replies as">
                <SelectValue>{READ_MODE_LABELS[settings.readMode]}</SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {(Object.keys(READ_MODE_LABELS) as SpeechReadMode[]).map((mode) => (
                  <SelectItem key={mode} hideIndicator value={mode}>
                    {READ_MODE_LABELS[mode]}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        />
        <SettingsRow
          {...searchableSetting("voice-playback-speed")}
          description="Speed of read aloud playback."
          control={
            <Select
              value={String(settings.playbackRate)}
              onValueChange={(value) => {
                const playbackRate = Number(value);
                setSpeechPlaybackRate(playbackRate);
                void updateSpeechSettings((current) => ({ ...current, playbackRate }));
              }}
            >
              <SelectTrigger size="sm" className="w-full sm:w-56" aria-label="Playback speed">
                <SelectValue>{`${settings.playbackRate}×`}</SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {PLAYBACK_RATES.map((rate) => (
                  <SelectItem key={rate} hideIndicator value={String(rate)}>
                    {`${rate}×`}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        />
        <SettingsRow
          {...searchableSetting("voice-dictation")}
          description="Adds a microphone to the composer that transcribes what you say."
          control={
            <ProviderSelect
              label="Dictate with"
              offLabel="Off"
              value={settings.transcriptionProviderId}
              providers={settings.providers}
              problem={transcriptionProviderProblem}
              onChange={(transcriptionProviderId) =>
                void updateSpeechSettings((current) => ({ ...current, transcriptionProviderId }))
              }
            />
          }
        />
      </SettingsSection>

      <SettingsSection
        {...searchableSetting("voice-providers")}
        title="Voice providers"
        headerAction={
          <div className="flex gap-2">
            {(Object.keys(SPEECH_PROVIDER_KINDS) as SpeechProviderKind[]).map((kind) => (
              <Button key={kind} size="xs" variant="outline" onClick={() => addProvider(kind)}>
                Add {SPEECH_PROVIDER_KINDS[kind].label}
              </Button>
            ))}
          </div>
        }
      >
        {settings.providers.length === 0 ? (
          <p className="px-4 py-4 text-muted-foreground text-sm">
            Add OpenAI, ElevenLabs, or a server with OpenAI-compatible /audio/speech (16-bit WAV)
            and /audio/transcriptions endpoints. Keys stay on this device and go only to the
            provider.
          </p>
        ) : (
          settings.providers.map((provider) => (
            <ProviderCard key={provider.id} provider={provider} />
          ))
        )}
      </SettingsSection>
    </SettingsPageContainer>
  );
}
