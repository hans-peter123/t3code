import { randomUUID } from "expo-crypto";
import { useState } from "react";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text, AppTextInput } from "../../components/ui/AppText";
import * as Dialog from "../../components/ui/Dialog";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { SegmentedControl } from "../../components/ui/SegmentedControl";
import { SettingsActionRow } from "../settings/components/SettingsActionRow";
import { SettingsChoiceRow } from "../settings/components/SettingsChoiceRow";
import { SettingsSection } from "../settings/components/SettingsSection";
import { listElevenLabsVoices, type SpeechVoice } from "@t3tools/client-runtime/speech";
import { setSpeechPlaybackRate, speakMessage, stopSpeech } from "./speechPlayback";
import {
  OPENAI_VOICES,
  PLAYBACK_RATES,
  SPEECH_PROVIDER_KINDS,
  speechProviderProblem,
  type SpeechProviderConfig,
  type SpeechProviderKind,
  transcriptionProviderProblem,
  updateSpeechSettings,
  useSpeechSettings,
} from "./speechSettings";

const SAMPLE_TEXT = "Hi! This is how T3 Code reads your messages aloud.";

function providerLabel(provider: SpeechProviderConfig): string {
  return provider.name.trim() || SPEECH_PROVIDER_KINDS[provider.kind].label;
}

function addProvider(kind: SpeechProviderKind, onAdded: (id: string) => void) {
  const defaults = SPEECH_PROVIDER_KINDS[kind];
  const provider: SpeechProviderConfig = {
    id: randomUUID(),
    kind,
    name: "",
    apiKey: "",
    baseUrl: "",
    model: defaults.defaultModel,
    voice: defaults.defaultVoice,
    transcriptionModel: defaults.defaultTranscriptionModel,
  };
  void updateSpeechSettings((current) => ({
    ...current,
    providers: [...current.providers, provider],
    // The first provider also turns read aloud on; later ones are picked explicitly.
    activeProviderId: current.providers.length === 0 ? provider.id : current.activeProviderId,
  }));
  onAdded(provider.id);
}

function editProvider(id: string, patch: Partial<SpeechProviderConfig>) {
  void updateSpeechSettings((current) => ({
    ...current,
    providers: current.providers.map((provider) =>
      provider.id === id ? { ...provider, ...patch } : provider,
    ),
  }));
}

function Field(props: {
  readonly label: string;
  readonly value: string;
  readonly placeholder?: string;
  readonly secure?: boolean;
  readonly keyboardType?: "default" | "url";
  readonly separated?: boolean;
  readonly onChange: (value: string) => void;
}) {
  return (
    <View
      className={
        props.separated ? "gap-1.5 border-t border-border-subtle px-4 py-3" : "gap-1.5 px-4 py-3"
      }
    >
      <Text className="text-sm text-foreground-muted">{props.label}</Text>
      <AppTextInput
        accessibilityLabel={props.label}
        defaultValue={props.value}
        placeholder={props.placeholder}
        secureTextEntry={props.secure}
        keyboardType={props.keyboardType ?? "default"}
        autoCapitalize="none"
        autoCorrect={false}
        className="min-h-10 rounded-xl px-3 py-2 text-base text-foreground"
        onChangeText={props.onChange}
      />
    </View>
  );
}

function VoicePicker(props: {
  readonly provider: SpeechProviderConfig;
  readonly onPick: (voice: string) => void;
}) {
  const { provider } = props;
  const [voices, setVoices] = useState<readonly SpeechVoice[] | null>(null);
  const [loading, setLoading] = useState(false);
  const options: readonly SpeechVoice[] | null =
    provider.kind === "openai"
      ? OPENAI_VOICES.map((voice) => ({ id: voice, name: voice }))
      : voices;

  return (
    <>
      {provider.kind === "elevenlabs" ? (
        <SettingsActionRow
          icon="arrow.clockwise"
          label={voices ? "Reload voices" : "Load voices"}
          description={provider.apiKey.trim() ? undefined : "Add an API key first."}
          disabled={!provider.apiKey.trim()}
          loading={loading}
          onPress={() => {
            setLoading(true);
            listElevenLabsVoices(provider.apiKey)
              .then(setVoices, (error: unknown) =>
                Dialog.alert(
                  "Could not load voices",
                  error instanceof Error ? error.message : "Try again.",
                ),
              )
              .finally(() => setLoading(false));
          }}
        />
      ) : null}
      {options?.map((voice) => (
        <SettingsChoiceRow
          key={voice.id}
          label={voice.name}
          selected={provider.voice === voice.id}
          separated
          onPress={() => props.onPick(voice.id)}
        />
      ))}
    </>
  );
}

function ProviderSettings(props: { readonly provider: SpeechProviderConfig }) {
  const { provider } = props;
  const kind = SPEECH_PROVIDER_KINDS[provider.kind];
  const [testing, setTesting] = useState(false);
  // A picked voice remounts the uncontrolled voice field; typing must not.
  const [voicePicks, setVoicePicks] = useState(0);
  const problem = speechProviderProblem(provider);

  return (
    <>
      <SettingsSection title={`${kind.label} settings`}>
        <Field
          label="Name"
          value={provider.name}
          placeholder={kind.label}
          onChange={(name) => editProvider(provider.id, { name })}
        />
        {provider.kind === "openai-compatible" ? (
          <Field
            label="Server URL"
            value={provider.baseUrl}
            placeholder="http://my-server:8880/v1"
            keyboardType="url"
            separated
            onChange={(baseUrl) => editProvider(provider.id, { baseUrl })}
          />
        ) : null}
        <Field
          label={provider.kind === "openai-compatible" ? "API key (optional)" : "API key"}
          value={provider.apiKey}
          placeholder={provider.kind === "elevenlabs" ? "sk_…" : "sk-…"}
          secure
          separated
          onChange={(apiKey) => editProvider(provider.id, { apiKey })}
        />
        <Field
          label="Speech model (read aloud)"
          value={provider.model}
          placeholder={kind.defaultModel}
          separated
          onChange={(model) => editProvider(provider.id, { model })}
        />
        <Field
          key={voicePicks}
          label={provider.kind === "elevenlabs" ? "Voice ID" : "Voice"}
          value={provider.voice}
          placeholder={kind.defaultVoice || "Voice ID"}
          separated
          onChange={(voice) => editProvider(provider.id, { voice })}
        />
        <Field
          label="Transcription model (dictation)"
          value={provider.transcriptionModel}
          placeholder={kind.defaultTranscriptionModel}
          separated
          onChange={(transcriptionModel) => editProvider(provider.id, { transcriptionModel })}
        />
      </SettingsSection>

      {provider.kind !== "openai-compatible" ? (
        <SettingsSection title="Voices">
          <VoicePicker
            provider={provider}
            onPick={(voice) => {
              editProvider(provider.id, { voice });
              setVoicePicks((count) => count + 1);
            }}
          />
        </SettingsSection>
      ) : null}

      <SettingsSection footer={problem ? `Read aloud: ${problem}` : undefined}>
        <SettingsActionRow
          icon="play"
          label="Play sample"
          disabled={problem !== null}
          loading={testing}
          onPress={() => {
            setTesting(true);
            speakMessage({
              messageId: `sample:${provider.id}`,
              markdown: SAMPLE_TEXT,
              title: "Voice sample",
            })
              .catch((error: unknown) =>
                Dialog.alert(
                  "Could not play the sample",
                  error instanceof Error ? error.message : "Try again.",
                ),
              )
              .finally(() => setTesting(false));
          }}
        />
        <SettingsActionRow
          icon="trash"
          label="Remove provider"
          tone="danger"
          onPress={() =>
            Dialog.confirm({
              title: `Remove ${providerLabel(provider)}?`,
              message: "Its API key is deleted from this device.",
              confirmText: "Remove",
              destructive: true,
              onConfirm: () => {
                stopSpeech();
                void updateSpeechSettings((current) => ({
                  ...current,
                  providers: current.providers.filter((entry) => entry.id !== provider.id),
                }));
              },
            })
          }
        />
      </SettingsSection>
    </>
  );
}

function roleDescription(provider: SpeechProviderConfig, problem: string | null): string {
  return problem ?? SPEECH_PROVIDER_KINDS[provider.kind].label;
}

export function SettingsSpeechRouteScreen() {
  const insets = useSafeAreaInsets();
  const settings = useSpeechSettings();
  const [editingId, setEditingId] = useState<string | null>(null);
  const editing =
    settings.providers.find((provider) => provider.id === editingId) ??
    settings.providers[0] ??
    null;

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-5 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        <SettingsSection title="Read aloud with">
          <SettingsChoiceRow
            label="Off"
            description="Hide the read aloud button"
            selected={settings.activeProviderId === null}
            onPress={() =>
              void updateSpeechSettings((current) => ({ ...current, activeProviderId: null }))
            }
          />
          {settings.providers.map((provider) => (
            <SettingsChoiceRow
              key={provider.id}
              label={providerLabel(provider)}
              description={roleDescription(provider, speechProviderProblem(provider))}
              selected={provider.id === settings.activeProviderId}
              separated
              onPress={() =>
                void updateSpeechSettings((current) => ({
                  ...current,
                  activeProviderId: provider.id,
                }))
              }
            />
          ))}
        </SettingsSection>

        <SettingsSection
          title="Dictate with"
          footer="Used by the microphone in the message composer."
        >
          <SettingsChoiceRow
            label="On this iPhone"
            description="Apple speech recognition, iOS 26 or later"
            selected={settings.transcriptionProviderId === null}
            onPress={() =>
              void updateSpeechSettings((current) => ({
                ...current,
                transcriptionProviderId: null,
              }))
            }
          />
          {settings.providers.map((provider) => (
            <SettingsChoiceRow
              key={provider.id}
              label={providerLabel(provider)}
              description={roleDescription(provider, transcriptionProviderProblem(provider))}
              selected={provider.id === settings.transcriptionProviderId}
              separated
              onPress={() =>
                void updateSpeechSettings((current) => ({
                  ...current,
                  transcriptionProviderId: provider.id,
                }))
              }
            />
          ))}
        </SettingsSection>

        <SettingsSection
          title="Providers"
          footer="API keys are stored in this device's keychain and sent only to the provider."
        >
          {settings.providers.map((provider, index) => (
            <SettingsChoiceRow
              key={provider.id}
              label={providerLabel(provider)}
              description="Tap to edit"
              selected={provider.id === editing?.id}
              separated={index > 0}
              onPress={() => setEditingId(provider.id)}
            />
          ))}
          <SettingsActionRow
            icon="plus"
            label="Add provider"
            onPress={() =>
              Dialog.alert("Add provider", undefined, [
                ...(Object.keys(SPEECH_PROVIDER_KINDS) as SpeechProviderKind[]).map((kind) => ({
                  text: SPEECH_PROVIDER_KINDS[kind].label,
                  onPress: () => addProvider(kind, setEditingId),
                })),
                { text: "Cancel", style: "cancel" as const },
              ])
            }
          />
        </SettingsSection>

        {/* Keyed so inputs and loaded voices reset when another provider is edited. */}
        {editing ? <ProviderSettings key={editing.id} provider={editing} /> : null}

        <SettingsSection title="Playback speed">
          <View className="p-3">
            <SegmentedControl
              options={PLAYBACK_RATES.map((rate) => ({ value: rate, label: `${rate}×` }))}
              selected={settings.playbackRate}
              onSelect={(playbackRate) => {
                setSpeechPlaybackRate(playbackRate);
                void updateSpeechSettings((current) => ({ ...current, playbackRate }));
              }}
            />
          </View>
        </SettingsSection>

        <Text className="px-2 text-sm text-foreground-muted">
          Custom servers need OpenAI-compatible endpoints: /audio/speech returning 16-bit WAV for
          read aloud (Kokoro-FastAPI, openedai-speech) and /audio/transcriptions for dictation
          (faster-whisper, Speaches). They can run on your local network or a VPN.
        </Text>
      </ScrollView>
    </View>
  );
}
