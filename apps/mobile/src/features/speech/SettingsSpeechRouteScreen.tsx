import { useNavigation } from "@react-navigation/native";
import { Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { ListRow } from "../../components/ui/ListRow";
import { ListRowLayout } from "../../components/ui/ListRowLayout";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { SettingsSection } from "../settings/components/SettingsSection";
import {
  SPEECH_PROVIDER_KINDS,
  speechProviderProblem,
  stepPlaybackRate,
  type SpeechProviderConfig,
  type SpeechSettings,
  transcriptionProviderProblem,
  useSpeechSettings,
} from "./speechSettings";
import { providerLabel, setPlaybackRate, startAddingProvider } from "./speechSettingsEdits";

function RateStepButton(props: {
  readonly icon: "minus" | "plus";
  readonly label: string;
  readonly disabled: boolean;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.label}
      accessibilityState={{ disabled: props.disabled }}
      disabled={props.disabled}
      hitSlop={6}
      onPress={props.onPress}
      className="size-9 items-center justify-center rounded-full bg-subtle"
      style={({ pressed }) => ({ opacity: props.disabled ? 0.35 : pressed ? 0.55 : 1 })}
    >
      <SymbolView
        name={props.icon}
        size={15}
        tintColorClassName="accent-icon"
        type="monochrome"
        weight="semibold"
      />
    </Pressable>
  );
}

function PlaybackSpeedRow(props: { readonly rate: number; readonly disabled: boolean }) {
  const slower = props.disabled ? props.rate : stepPlaybackRate(props.rate, -1);
  const faster = props.disabled ? props.rate : stepPlaybackRate(props.rate, 1);
  return (
    <View
      accessible
      accessibilityRole="adjustable"
      accessibilityLabel="Speed"
      accessibilityValue={{ text: `${props.rate} times` }}
      accessibilityHint={
        props.disabled
          ? "Choose a provider to read aloud first."
          : "Double-tap to reset to normal speed."
      }
      accessibilityState={{ disabled: props.disabled }}
      accessibilityActions={[{ name: "increment" }, { name: "decrement" }, { name: "activate" }]}
      onAccessibilityAction={({ nativeEvent }) => {
        if (nativeEvent.actionName === "increment") setPlaybackRate(faster);
        if (nativeEvent.actionName === "decrement") setPlaybackRate(slower);
        if (nativeEvent.actionName === "activate" && !props.disabled) setPlaybackRate(1);
      }}
    >
      <ListRowLayout
        label="Speed"
        disabled={props.disabled}
        accessory={
          <View className="flex-row items-center gap-2">
            <RateStepButton
              icon="minus"
              label="Slower"
              disabled={slower === props.rate}
              onPress={() => setPlaybackRate(slower)}
            />
            {/* Tapping the value resets to normal speed. */}
            <Pressable
              disabled={props.disabled || props.rate === 1}
              hitSlop={8}
              onPress={() => setPlaybackRate(1)}
            >
              <Text className="min-w-14 text-center font-t3-medium text-base tabular-nums text-foreground">
                {`${props.rate.toFixed(2)}×`}
              </Text>
            </Pressable>
            <RateStepButton
              icon="plus"
              label="Faster"
              disabled={faster === props.rate}
              onPress={() => setPlaybackRate(faster)}
            />
          </View>
        }
      />
    </View>
  );
}

/** What a provider row says: a missing piece for its job first, then what it is used for. */
function providerSummary(settings: SpeechSettings, provider: SpeechProviderConfig): string {
  const reading = provider.id === settings.activeProviderId;
  const dictating = provider.id === settings.transcriptionProviderId;
  const problem =
    (reading ? speechProviderProblem(provider) : null) ??
    (dictating ? transcriptionProviderProblem(provider) : null);
  if (problem) return problem;
  const roles = [reading ? "Read aloud" : null, dictating ? "Dictation" : null].filter(Boolean);
  return `${SPEECH_PROVIDER_KINDS[provider.kind].label} · ${roles.join(", ") || "Not in use"}`;
}

export function SettingsSpeechRouteScreen() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();
  const settings = useSpeechSettings();
  const reader = settings.providers.find((entry) => entry.id === settings.activeProviderId);
  const transcriber = settings.providers.find(
    (entry) => entry.id === settings.transcriptionProviderId,
  );
  const readerProblem = reader ? speechProviderProblem(reader) : null;
  const transcriberProblem = transcriber ? transcriptionProviderProblem(transcriber) : null;

  const chooseKind = () =>
    startAddingProvider(null, (providerId) =>
      navigation.navigate("SettingsSpeechProvider", { providerId }),
    );

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-5 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        <SettingsSection
          title="Read aloud"
          footer="Adds a speaker button to assistant replies. Playback continues on the lock screen."
        >
          <ListRow
            icon="speaker.wave.2"
            label="Read with"
            description={readerProblem ?? undefined}
            detail={reader ? providerLabel(reader) : "Off"}
            onPress={() => navigation.navigate("SettingsSpeechRole", { role: "readAloud" })}
          />
          <PlaybackSpeedRow rate={settings.playbackRate} disabled={!reader} />
        </SettingsSection>

        <SettingsSection title="Dictation" footer="Used by the microphone in the message composer.">
          <ListRow
            icon="text.bubble"
            label="Transcribe with"
            description={transcriberProblem ?? undefined}
            detail={transcriber ? providerLabel(transcriber) : "This iPhone"}
            onPress={() => navigation.navigate("SettingsSpeechRole", { role: "dictation" })}
          />
          <ListRow
            icon="mic"
            label="Microphone"
            onPress={() => navigation.navigate("SettingsMicrophone")}
          />
        </SettingsSection>

        <SettingsSection
          title="Providers"
          footer={
            settings.providers.length === 0
              ? "Add OpenAI, ElevenLabs, or your own server to read replies aloud with natural voices and to transcribe dictation in the cloud."
              : "API keys stay in this iPhone's keychain and are sent only to their provider."
          }
        >
          {settings.providers.map((provider) => (
            <ListRow
              key={provider.id}
              label={providerLabel(provider)}
              description={providerSummary(settings, provider)}
              onPress={() =>
                navigation.navigate("SettingsSpeechProvider", { providerId: provider.id })
              }
            />
          ))}
          <ListActionRow icon="plus" label="Add provider" onPress={chooseKind} />
        </SettingsSection>
      </ScrollView>
    </View>
  );
}
