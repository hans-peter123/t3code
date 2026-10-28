import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { listElevenLabsVoices, type SpeechVoice } from "@t3tools/client-runtime/speech";
import { type ReactNode, useEffect, useState } from "react";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { AppText as Text, AppTextInput } from "../../components/ui/AppText";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { ListChoiceRow } from "../../components/ui/ListChoiceRow";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { SettingsSection } from "../settings/components/SettingsSection";
import { type DictationLocaleChoice, dictationLocaleChoices } from "./dictationLanguage";
import { useSpeechPlayback } from "./speechPlayback";
import {
  OPENAI_VOICES,
  SPEECH_PROVIDER_KINDS,
  speechProviderProblem,
  type SpeechProviderConfig,
  transcriptionProviderProblem,
  updateSpeechSettings,
  useSpeechSettings,
} from "./speechSettings";
import {
  assignRole,
  editProvider,
  playVoiceSample,
  providerLabel,
  sampleMessageId,
  type SpeechRole,
  startAddingProvider,
} from "./speechSettingsEdits";

function PickerScreen(props: { readonly children: ReactNode }) {
  const insets = useSafeAreaInsets();
  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      <ScrollView
        automaticallyAdjustKeyboardInsets
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-5 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        {props.children}
      </ScrollView>
    </View>
  );
}

const ROLES = {
  readAloud: {
    none: "Off",
    noneDescription: "Hides the read aloud button",
    problem: speechProviderProblem,
  },
  dictation: {
    none: "This iPhone",
    noneDescription: "Apple speech recognition on device, iOS 26 or later",
    problem: transcriptionProviderProblem,
  },
} as const;

export function SettingsSpeechRoleRouteScreen({
  route,
}: StaticScreenProps<{ readonly role: SpeechRole }>) {
  const navigation = useNavigation();
  const settings = useSpeechSettings();
  // A deep link can carry any segment here.
  const roleId: SpeechRole = route.params.role === "dictation" ? "dictation" : "readAloud";
  const role = ROLES[roleId];
  const selectedId =
    roleId === "readAloud" ? settings.activeProviderId : settings.transcriptionProviderId;

  return (
    <PickerScreen>
      <SettingsSection>
        <ListChoiceRow
          label={role.none}
          description={role.noneDescription}
          selected={selectedId === null}
          onPress={() => assignRole(roleId, null)}
        />
        {settings.providers.map((provider) => (
          <ListChoiceRow
            key={provider.id}
            label={providerLabel(provider)}
            description={role.problem(provider) ?? SPEECH_PROVIDER_KINDS[provider.kind].label}
            selected={provider.id === selectedId}
            separated
            onPress={() => assignRole(roleId, provider.id)}
          />
        ))}
      </SettingsSection>
      <SettingsSection>
        <ListActionRow
          icon="plus"
          label="Add provider"
          onPress={() =>
            startAddingProvider(roleId, (providerId) =>
              navigation.navigate("SettingsSpeechProvider", { providerId }),
            )
          }
        />
      </SettingsSection>
    </PickerScreen>
  );
}

type VoiceList =
  | { readonly status: "loading" }
  | { readonly status: "loaded"; readonly voices: readonly SpeechVoice[] }
  | { readonly status: "failed"; readonly message: string };

const VOICE_LIST_TIMEOUT_MS = 20_000;

/** Mounted once per key and attempt, so a retry or a new key starts a fresh request. */
function useElevenLabsVoices(apiKey: string) {
  const [list, setList] = useState<VoiceList>({ status: "loading" });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- fetches the account's voices from ElevenLabs.
  useEffect(() => {
    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, VOICE_LIST_TIMEOUT_MS);
    listElevenLabsVoices(apiKey, controller.signal)
      .then(
        (voices) => setList({ status: "loaded", voices }),
        (error: unknown) => {
          if (controller.signal.aborted && !timedOut) return;
          setList({
            status: "failed",
            message: timedOut
              ? "ElevenLabs did not answer."
              : error instanceof Error
                ? error.message
                : "Try again.",
          });
        },
      )
      .finally(() => clearTimeout(timeout));
    return () => controller.abort();
  }, [apiKey]);
  return list;
}

function VoiceChoices(props: {
  readonly provider: SpeechProviderConfig;
  readonly voices: readonly SpeechVoice[];
  readonly onPick?: () => void;
}) {
  const pick = (voice: SpeechVoice) => {
    editProvider(props.provider.id, { voice: voice.id, voiceName: voice.name });
    props.onPick?.();
    // Hearing the voice is the point of picking one.
    void playVoiceSample({ ...props.provider, voice: voice.id });
  };
  const preparing = useSpeechPlayback(sampleMessageId(props.provider)).phase === "preparing";
  return props.voices.map((voice, index) => (
    <ListChoiceRow
      key={voice.id}
      label={voice.name}
      description={preparing && props.provider.voice === voice.id ? "Loading sample…" : undefined}
      selected={props.provider.voice === voice.id}
      separated={index > 0}
      onPress={() => pick(voice)}
    />
  ));
}

function ElevenLabsVoices(props: { readonly provider: SpeechProviderConfig }) {
  const [attempt, setAttempt] = useState(0);
  // A pick from the list remounts the Voice ID field so it shows the picked ID.
  const [picks, setPicks] = useState(0);
  return (
    <>
      <ElevenLabsVoiceList
        key={`${props.provider.apiKey}:${attempt}`}
        provider={props.provider}
        retry={() => setAttempt((count) => count + 1)}
        onPick={() => setPicks((count) => count + 1)}
      />
      <SettingsSection
        title="Voice ID"
        footer="Paste the ID of a shared or library voice that is not in your list."
      >
        <AppTextInput
          key={picks}
          accessibilityLabel="Voice ID"
          defaultValue={props.provider.voice}
          placeholder="Voice ID"
          autoCapitalize="none"
          autoCorrect={false}
          spellCheck={false}
          returnKeyType="done"
          className="min-h-14 rounded-none border-0 bg-transparent px-4 py-3 text-base text-foreground"
          onChangeText={(voice) =>
            editProvider(props.provider.id, { voice: voice.trim(), voiceName: "" })
          }
        />
      </SettingsSection>
    </>
  );
}

function ElevenLabsVoiceList(props: {
  readonly provider: SpeechProviderConfig;
  readonly retry: () => void;
  readonly onPick: () => void;
}) {
  const list = useElevenLabsVoices(props.provider.apiKey);
  return (
    <SettingsSection title="Your voices" footer="Tap a voice to hear it.">
      {list.status === "loading" ? (
        <View className="min-h-14 items-center justify-center">
          <AppActivityIndicator colorClassName="accent-icon" />
        </View>
      ) : list.status === "failed" ? (
        <ListActionRow
          icon="arrow.clockwise"
          label="Try again"
          description={list.message}
          onPress={props.retry}
        />
      ) : list.voices.length === 0 ? (
        <Text className="px-4 py-4 text-foreground-muted">
          No voices in this ElevenLabs account yet.
        </Text>
      ) : (
        <VoiceChoices provider={props.provider} voices={list.voices} onPick={props.onPick} />
      )}
    </SettingsSection>
  );
}

const OPENAI_VOICE_CHOICES: readonly SpeechVoice[] = OPENAI_VOICES.map((voice) => ({
  id: voice,
  name: voice[0]!.toUpperCase() + voice.slice(1),
}));

export function SettingsSpeechVoiceRouteScreen({
  route,
}: StaticScreenProps<{ readonly providerId: string }>) {
  const settings = useSpeechSettings();
  const provider = settings.providers.find((entry) => entry.id === route.params.providerId);
  if (!provider) return <View className="flex-1 bg-sheet" />;

  return (
    <PickerScreen>
      {provider.kind === "elevenlabs" ? (
        <ElevenLabsVoices provider={provider} />
      ) : (
        <SettingsSection footer="Tap a voice to hear it.">
          <VoiceChoices provider={provider} voices={OPENAI_VOICE_CHOICES} />
        </SettingsSection>
      )}
    </PickerScreen>
  );
}

/** Languages dictation can listen for; null while the recognizer lists them. */
export function useDictationLocaleChoices(): readonly DictationLocaleChoice[] | null {
  const [choices, setChoices] = useState<readonly DictationLocaleChoice[] | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- asks the native recognizer which locales it supports.
  useEffect(() => {
    let current = true;
    void dictationLocaleChoices().then((next) => {
      if (current) setChoices(next);
    });
    return () => {
      current = false;
    };
  }, []);
  return choices;
}

function setDictationLanguage(dictationLanguage: string | null) {
  void updateSpeechSettings((current) => ({ ...current, dictationLanguage }));
}

export function SettingsDictationLanguageRouteScreen() {
  const settings = useSpeechSettings();
  const choices = useDictationLocaleChoices();
  return (
    <PickerScreen>
      <SettingsSection>
        <ListChoiceRow
          label="Automatic"
          description="On this iPhone, uses the language you write in the thread if it is already downloaded for dictation, otherwise the iPhone language. Dictating once in a language chosen below downloads it. Dictation providers detect the language you speak."
          selected={settings.dictationLanguage === null}
          onPress={() => setDictationLanguage(null)}
        />
      </SettingsSection>
      <SettingsSection>
        {choices === null ? (
          <View className="min-h-14 items-center justify-center">
            <AppActivityIndicator colorClassName="accent-icon" />
          </View>
        ) : (
          choices.map((choice, index) => (
            <ListChoiceRow
              key={choice.id}
              label={choice.name}
              selected={settings.dictationLanguage === choice.id}
              separated={index > 0}
              onPress={() => setDictationLanguage(choice.id)}
            />
          ))
        )}
      </SettingsSection>
    </PickerScreen>
  );
}
