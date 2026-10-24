import { useNavigation } from "@react-navigation/native";
import { memo } from "react";
import { Pressable, View, type ColorValue } from "react-native";

import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { type AppSymbolName, SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import * as Dialog from "../../components/ui/Dialog";
import { openSettings } from "../settings/settings-navigation";
import {
  SPEECH_SKIP_SECONDS,
  SpeechNotConfiguredError,
  seekSpeech,
  speakMessage,
  stopSpeech,
  useSpeechPlayback,
} from "./speechPlayback";

function formatTime(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

function ControlButton(props: {
  readonly icon: AppSymbolName;
  readonly label: string;
  readonly tintColor: ColorValue;
  readonly size: number;
  readonly iconSize: number;
  readonly disabled?: boolean;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.label}
      disabled={props.disabled}
      hitSlop={6}
      onPress={props.onPress}
      style={({ pressed }) => ({
        width: props.size,
        height: props.size,
        alignItems: "center",
        justifyContent: "center",
        borderRadius: 9,
        opacity: props.disabled ? 0.4 : pressed ? 0.52 : 1,
      })}
    >
      <SymbolView
        name={props.icon}
        size={props.iconSize}
        tintColor={props.tintColor}
        type="monochrome"
      />
    </Pressable>
  );
}

/** Reads an assistant message aloud; expands into transport controls while it is loaded. */
export const SpeakMessageButton = memo(function SpeakMessageButton(props: {
  readonly messageId: string;
  readonly markdown: string;
  readonly title: string;
  readonly tintColor: ColorValue;
  readonly buttonSize?: number;
  readonly iconSize?: number;
}) {
  const navigation = useNavigation();
  const playback = useSpeechPlayback(props.messageId);
  const size = props.buttonSize ?? 28;
  const iconSize = props.iconSize ?? 13;

  const start = () => {
    speakMessage({
      messageId: props.messageId,
      markdown: props.markdown,
      title: props.title,
    }).catch((error: unknown) => {
      if (error instanceof SpeechNotConfiguredError) {
        Dialog.confirm({
          title: "Set up read aloud",
          message: error.message,
          confirmText: "Open Settings",
          onConfirm: () => openSettings(navigation, "SettingsSpeech"),
        });
        return;
      }
      Dialog.alert("Could not read aloud", error instanceof Error ? error.message : "Try again.");
    });
  };

  if (playback.phase === "idle") {
    return (
      <ControlButton
        icon="speaker.wave.2"
        label="Read aloud"
        tintColor={props.tintColor}
        size={size}
        iconSize={iconSize}
        disabled={props.markdown.trim().length === 0}
        onPress={start}
      />
    );
  }

  const preparing = playback.phase === "preparing";
  return (
    <View className="flex-row items-center">
      <ControlButton
        icon="gobackward.15"
        label={`Back ${SPEECH_SKIP_SECONDS} seconds`}
        tintColor={props.tintColor}
        size={size}
        iconSize={iconSize + 1}
        disabled={preparing}
        onPress={() => seekSpeech(-SPEECH_SKIP_SECONDS)}
      />
      {preparing ? (
        <View
          accessible
          accessibilityLabel="Preparing audio"
          style={{ width: size, height: size, alignItems: "center", justifyContent: "center" }}
        >
          <AppActivityIndicator size="small" color={props.tintColor} />
        </View>
      ) : (
        <ControlButton
          icon={playback.phase === "playing" ? "pause.fill" : "play.fill"}
          label={playback.phase === "playing" ? "Pause" : "Resume"}
          tintColor={props.tintColor}
          size={size}
          iconSize={iconSize}
          onPress={start}
        />
      )}
      <ControlButton
        icon="goforward.15"
        label={`Forward ${SPEECH_SKIP_SECONDS} seconds`}
        tintColor={props.tintColor}
        size={size}
        iconSize={iconSize + 1}
        disabled={preparing}
        onPress={() => seekSpeech(SPEECH_SKIP_SECONDS)}
      />
      <ControlButton
        icon="stop.fill"
        label="Stop reading"
        tintColor={props.tintColor}
        size={size}
        iconSize={iconSize - 1}
        onPress={stopSpeech}
      />
      {preparing ? null : (
        <Text className="ml-1 font-t3-medium text-xs tabular-nums text-foreground-secondary">
          {formatTime(playback.currentTime)} / {formatTime(playback.duration)}
        </Text>
      )}
    </View>
  );
});
