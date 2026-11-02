import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import {
  fixedSpeechChoices,
  listSpeechChoices,
  newSpeechProvider,
  type SpeechChoice,
  type SpeechChoiceField,
} from "@t3tools/client-runtime/speech";
import { type ReactNode, useEffect, useState } from "react";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { AppText as Text, AppTextInput } from "../../components/ui/AppText";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { ListChoiceRow } from "../../components/ui/ListChoiceRow";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { SettingsSection } from "../settings/components/SettingsSection";
import { SpeechProviderIcon } from "./SpeechProviderIcon";
import { type DictationLocaleChoice, dictationLocaleChoices } from "./dictationLanguage";
import { useSpeechPlayback } from "./speechPlayback";
import {
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
            leading={<SpeechProviderIcon provider={provider} />}
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

type ChoiceList =
  | { readonly status: "loading" }
  | { readonly status: "loaded"; readonly choices: readonly SpeechChoice[] }
  | { readonly status: "failed"; readonly message: string };

const CHOICE_LIST_TIMEOUT_MS = 20_000;

/** Refetches when what the provider is asked changes; a retry remounts it. */
function useProviderChoices(provider: SpeechProviderConfig, field: SpeechChoiceField) {
  const { kind, apiKey, baseUrl } = provider;
  // Voices and languages depend on the speech model; voices are ordered by the language.
  const model = field === "voice" || field === "language" ? provider.model : "";
  const language = field === "voice" ? (provider.language ?? "") : "";
  const [list, setList] = useState<ChoiceList>({ status: "loading" });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- fetches the provider's voices or models.
  useEffect(() => {
    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, CHOICE_LIST_TIMEOUT_MS);
    // Only what reaches the provider, so picking a choice does not refetch the list.
    listSpeechChoices(
      newSpeechProvider("list", kind, { apiKey, baseUrl, model, language }),
      field,
      controller.signal,
    )
      .then(
        (choices) => setList({ status: "loaded", choices }),
        (error: unknown) => {
          if (controller.signal.aborted && !timedOut) return;
          setList({
            status: "failed",
            message: timedOut
              ? `${SPEECH_PROVIDER_KINDS[kind].label} did not answer.`
              : error instanceof Error
                ? error.message
                : "Try again.",
          });
        },
      )
      .finally(() => clearTimeout(timeout));
    return () => controller.abort();
  }, [kind, apiKey, baseUrl, model, language, field]);
  return list;
}

const FIELD_COPY = {
  voice: { listTitle: "Voices", idLabel: "Voice ID", footer: "Tap a voice to hear it." },
  model: { listTitle: "Models", idLabel: "Model ID", footer: undefined },
  transcriptionModel: { listTitle: "Models", idLabel: "Model ID", footer: undefined },
  language: {
    listTitle: "Languages",
    idLabel: "Language code",
    footer: "Voices sound most natural in their own language, so those come first.",
  },
} as const;

function patchFor(field: SpeechChoiceField, choice: SpeechChoice | string) {
  const id = typeof choice === "string" ? choice : choice.id;
  if (field === "voice") {
    return { voice: id, voiceName: typeof choice === "string" ? "" : choice.name };
  }
  if (field === "language") return { language: id };
  return field === "model" ? { model: id } : { transcriptionModel: id };
}

function Choices(props: {
  readonly provider: SpeechProviderConfig;
  readonly field: SpeechChoiceField;
  readonly choices: readonly SpeechChoice[];
  readonly onPick?: () => void;
}) {
  const { provider, field } = props;
  const pick = (choice: SpeechChoice) => {
    editProvider(provider.id, patchFor(field, choice));
    props.onPick?.();
    // Hearing the voice is the point of picking one.
    if (field === "voice") void playVoiceSample({ ...provider, voice: choice.id });
  };
  const preparing = useSpeechPlayback(sampleMessageId(provider)).phase === "preparing";
  return props.choices.map((choice, index) => (
    <ListChoiceRow
      key={choice.id}
      label={choice.name}
      description={
        field === "voice" && preparing && provider.voice === choice.id
          ? "Loading sample…"
          : choice.description
      }
      selected={(provider[field] ?? "") === choice.id}
      separated={index > 0}
      onPress={() => pick(choice)}
    />
  ));
}

function FetchedChoices(props: {
  readonly provider: SpeechProviderConfig;
  readonly field: SpeechChoiceField;
  readonly retry: () => void;
  readonly onPick: () => void;
}) {
  const list = useProviderChoices(props.provider, props.field);
  const copy = FIELD_COPY[props.field];
  return (
    <SettingsSection title={copy.listTitle} footer={copy.footer}>
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
      ) : list.choices.length === 0 ? (
        <Text className="px-4 py-4 text-foreground-muted">
          {providerLabel(props.provider)} lists none yet.
        </Text>
      ) : (
        <Choices
          provider={props.provider}
          field={props.field}
          choices={list.choices}
          onPick={props.onPick}
        />
      )}
    </SettingsSection>
  );
}

function ChoicePicker(props: {
  readonly provider: SpeechProviderConfig;
  readonly field: SpeechChoiceField;
}) {
  const { provider, field } = props;
  const [attempt, setAttempt] = useState(0);
  // A pick from the list remounts the ID field so it shows the picked ID.
  const [picks, setPicks] = useState(0);
  const fixed = fixedSpeechChoices(provider, field);
  const copy = FIELD_COPY[field];
  const onPick = () => setPicks((count) => count + 1);
  return (
    <PickerScreen>
      {fixed ? (
        <SettingsSection footer={copy.footer}>
          <Choices provider={provider} field={field} choices={fixed} onPick={onPick} />
        </SettingsSection>
      ) : (
        <FetchedChoices
          key={attempt}
          provider={provider}
          field={field}
          retry={() => setAttempt((count) => count + 1)}
          onPick={onPick}
        />
      )}
      {/* OpenAI's voices are the whole set; every other list can miss one. */}
      {field === "voice" && fixed ? null : (
        <SettingsSection
          title={copy.idLabel}
          footer={
            field === "voice"
              ? "Paste the ID of a voice that is not in the list."
              : field === "language"
                ? "Leave empty to let the model detect the language."
                : "Type a model that is not in the list."
          }
        >
          <AppTextInput
            key={picks}
            accessibilityLabel={copy.idLabel}
            defaultValue={provider[field] ?? ""}
            placeholder={copy.idLabel}
            autoCapitalize="none"
            autoCorrect={false}
            spellCheck={false}
            returnKeyType="done"
            className="min-h-14 rounded-none border-0 bg-transparent px-4 py-3 text-base text-foreground"
            onChangeText={(value) => editProvider(provider.id, patchFor(field, value.trim()))}
          />
        </SettingsSection>
      )}
    </PickerScreen>
  );
}

function useRouteProvider(providerId: string) {
  return useSpeechSettings().providers.find((entry) => entry.id === providerId);
}

export function SettingsSpeechVoiceRouteScreen({
  route,
}: StaticScreenProps<{ readonly providerId: string }>) {
  const provider = useRouteProvider(route.params.providerId);
  if (!provider) return <View className="flex-1 bg-sheet" />;
  return <ChoicePicker provider={provider} field="voice" />;
}

export function SettingsSpeechModelRouteScreen({
  route,
}: StaticScreenProps<{ readonly providerId: string; readonly use: "speech" | "dictation" }>) {
  const provider = useRouteProvider(route.params.providerId);
  if (!provider) return <View className="flex-1 bg-sheet" />;
  // A deep link can carry any segment here.
  const field = route.params.use === "dictation" ? "transcriptionModel" : "model";
  return <ChoicePicker key={field} provider={provider} field={field} />;
}

export function SettingsSpeechLanguageRouteScreen({
  route,
}: StaticScreenProps<{ readonly providerId: string }>) {
  const provider = useRouteProvider(route.params.providerId);
  if (!provider) return <View className="flex-1 bg-sheet" />;
  return <ChoicePicker provider={provider} field="language" />;
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
