import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { describeTranscriptionTest, silentWav } from "@t3tools/client-runtime/speech";
import { useLayoutEffect, useState } from "react";
import { Alert, useWindowDimensions, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text, AppTextInput, type AppTextInputProps } from "../../components/ui/AppText";
import * as Dialog from "../../components/ui/Dialog";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { ListRow } from "../../components/ui/ListRow";
import { ListToggleRow } from "../../components/ui/ListToggleRow";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { cn } from "../../lib/cn";
import { SettingsSection } from "../settings/components/SettingsSection";
import {
  SPEECH_PROVIDER_KINDS,
  speechProviderProblem,
  type SpeechProviderConfig,
  transcriptionProviderProblem,
  useSpeechSettings,
} from "./speechSettings";
import {
  assignRole,
  editProvider,
  playVoiceSample,
  promptForApiKey,
  providerLabel,
  removeProvider,
} from "./speechSettingsEdits";
import { transcribeRecording } from "./speechTranscription";

/** Uploads a silent recording and reports exactly what the provider answered. */
async function testDictation(provider: SpeechProviderConfig): Promise<string> {
  const { File, Paths } = await import("expo-file-system");
  const file = new File(Paths.cache, "dictation-test.wav");
  if (file.exists) file.delete();
  await file.write(silentWav());
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60_000);
  const [result] = await Promise.allSettled([
    transcribeRecording(provider, file.uri, controller.signal),
  ]);
  clearTimeout(timeout);
  file.delete();
  return describeTranscriptionTest(result!);
}

function voiceLabel(provider: SpeechProviderConfig): string {
  if (provider.voiceName) return provider.voiceName;
  if (!provider.voice) return "Choose";
  // OpenAI voice ids are lowercase names.
  return provider.kind === "openai"
    ? provider.voice[0]!.toUpperCase() + provider.voice.slice(1)
    : provider.voice;
}

/**
 * An inline label and text field, like an account form in iOS Settings. Saves as the user types
 * and trims once editing ends, so a space typed mid-word is never stripped under the cursor.
 */
function FieldRow({
  label,
  onValue,
  ...inputProps
}: Omit<AppTextInputProps, "className" | "onChangeText" | "onEndEditing"> & {
  readonly label: string;
  readonly onValue: (value: string) => void;
}) {
  const stacked = useWindowDimensions().fontScale >= 1.5;
  return (
    <View
      collapsable={false}
      className={cn("min-h-14 justify-center gap-3 px-4 py-3", !stacked && "flex-row items-center")}
    >
      <Text
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        className={cn("text-base text-foreground", !stacked && "w-24")}
      >
        {label}
      </Text>
      <AppTextInput
        accessibilityLabel={label}
        autoCapitalize="none"
        autoCorrect={false}
        spellCheck={false}
        returnKeyType="done"
        {...inputProps}
        className={cn(
          "min-h-0 rounded-none border-0 bg-transparent p-0 text-base text-foreground",
          !stacked && "flex-1",
        )}
        onChangeText={onValue}
        onEndEditing={({ nativeEvent }) => {
          const trimmed = nativeEvent.text.trim();
          if (trimmed !== nativeEvent.text) onValue(trimmed);
        }}
      />
    </View>
  );
}

export function SettingsSpeechProviderRouteScreen({
  route,
}: StaticScreenProps<{ readonly providerId: string }>) {
  const settings = useSpeechSettings();
  const provider = settings.providers.find((entry) => entry.id === route.params.providerId);
  // Not loaded yet, or removed: there is nothing to edit.
  if (!provider) return <View className="flex-1 bg-sheet" />;
  return (
    <ProviderSettings
      key={provider.id}
      provider={provider}
      reading={settings.activeProviderId === provider.id}
      dictating={settings.transcriptionProviderId === provider.id}
    />
  );
}

function ProviderSettings(props: {
  readonly provider: SpeechProviderConfig;
  readonly reading: boolean;
  readonly dictating: boolean;
}) {
  const { provider } = props;
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();
  const kind = SPEECH_PROVIDER_KINDS[provider.kind];
  const custom = provider.kind === "openai-compatible";
  const [sampling, setSampling] = useState(false);
  const [testingDictation, setTestingDictation] = useState(false);
  const speechProblem = speechProviderProblem(provider);
  const dictationProblem = transcriptionProviderProblem(provider);
  const savedKey = provider.apiKey.trim();
  const edit = (patch: Partial<SpeechProviderConfig>) => editProvider(provider.id, patch);
  const title = providerLabel(provider);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the native header shows the provider's current name.
  useLayoutEffect(() => navigation.setOptions({ title }), [navigation, title]);
  const replaceKey = () => promptForApiKey(provider.kind, (apiKey) => edit({ apiKey }));

  const chooseKeyAction = () => {
    if (!savedKey) return replaceKey();
    Alert.alert(`Key ending in ${savedKey.slice(-4)}`, undefined, [
      { text: "Replace key", onPress: replaceKey },
      { text: "Remove key", style: "destructive", onPress: () => edit({ apiKey: "" }) },
      { text: "Cancel", style: "cancel" },
    ]);
  };

  const playSample = () => {
    setSampling(true);
    void playVoiceSample(provider).finally(() => setSampling(false));
  };

  const runDictationTest = () => {
    setTestingDictation(true);
    testDictation(provider)
      .then(
        (report) => Dialog.alert("Dictation test", report),
        (error: unknown) =>
          Dialog.alert("Dictation test", error instanceof Error ? error.message : "Try again."),
      )
      .finally(() => setTestingDictation(false));
  };

  const confirmRemove = () => {
    const uses = [props.reading ? "read aloud" : null, props.dictating ? "dictation" : null]
      .filter(Boolean)
      .join(" and ");
    Dialog.confirm({
      title: `Remove ${providerLabel(provider)}?`,
      message: uses
        ? `Its API key is deleted from this iPhone, and ${uses} switches off until you choose another provider.`
        : "Its API key is deleted from this iPhone.",
      confirmText: "Remove",
      destructive: true,
      onConfirm: () => {
        // Leave first, so the page doesn't go blank while it slides away.
        if (navigation.canGoBack()) navigation.goBack();
        removeProvider(provider.id);
      },
    });
  };

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      <ScrollView
        automaticallyAdjustKeyboardInsets
        contentInsetAdjustmentBehavior="automatic"
        keyboardDismissMode="interactive"
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-5 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        <SettingsSection
          title={kind.label}
          footer={
            custom
              ? "Needs OpenAI-compatible endpoints: /audio/speech returning 16-bit WAV (Kokoro-FastAPI, openedai-speech) and /audio/transcriptions (faster-whisper, Speaches). It can run on your local network or a VPN."
              : "Stored in this iPhone's keychain and sent only to " + kind.label + "."
          }
        >
          {custom ? (
            <FieldRow
              label="Server URL"
              defaultValue={provider.baseUrl}
              placeholder="http://my-server:8880/v1"
              keyboardType="url"
              textContentType="URL"
              onValue={(baseUrl) => edit({ baseUrl })}
            />
          ) : null}
          <ListRow
            label="API key"
            detail={savedKey ? `Ends in ${savedKey.slice(-4)}` : custom ? "None" : "Not set"}
            onPress={chooseKeyAction}
          />
          <FieldRow
            label="Name"
            defaultValue={provider.name}
            placeholder={kind.label}
            autoCapitalize="words"
            onValue={(name) => edit({ name })}
          />
        </SettingsSection>

        <SettingsSection title="Read aloud" footer={speechProblem ?? undefined}>
          <ListToggleRow
            label="Use for read aloud"
            value={props.reading}
            onValueChange={(on) => assignRole("readAloud", on ? provider.id : null)}
          />
          {custom ? (
            <FieldRow
              label="Voice"
              defaultValue={provider.voice}
              placeholder={kind.defaultVoice}
              onValue={(voice) => edit({ voice })}
            />
          ) : (
            <ListRow
              label="Voice"
              description={
                provider.kind === "elevenlabs" && !savedKey ? "Add an API key first." : undefined
              }
              disabled={provider.kind === "elevenlabs" && !savedKey}
              detail={voiceLabel(provider)}
              onPress={() =>
                navigation.navigate("SettingsSpeechVoice", { providerId: provider.id })
              }
            />
          )}
          <FieldRow
            label="Model"
            accessibilityLabel="Speech model"
            defaultValue={provider.model}
            placeholder={kind.defaultModel}
            onValue={(model) => edit({ model })}
          />
          <ListActionRow
            icon="play"
            label="Play sample"
            disabled={speechProblem !== null}
            loading={sampling}
            onPress={playSample}
          />
        </SettingsSection>

        <SettingsSection
          title="Dictation"
          footer={dictationProblem ?? "The test sends one second of silence and shows the answer."}
        >
          <ListToggleRow
            label="Use for dictation"
            value={props.dictating}
            onValueChange={(on) => assignRole("dictation", on ? provider.id : null)}
          />
          <FieldRow
            label="Model"
            accessibilityLabel="Transcription model"
            defaultValue={provider.transcriptionModel}
            placeholder={kind.defaultTranscriptionModel}
            onValue={(transcriptionModel) => edit({ transcriptionModel })}
          />
          <ListActionRow
            icon="mic"
            label="Test dictation"
            disabled={dictationProblem !== null}
            loading={testingDictation}
            onPress={runDictationTest}
          />
        </SettingsSection>

        <SettingsSection>
          <ListActionRow
            icon="trash"
            label="Remove provider"
            tone="danger"
            onPress={confirmRemove}
          />
        </SettingsSection>
      </ScrollView>
    </View>
  );
}
