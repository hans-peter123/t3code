import { useNavigation } from "@react-navigation/native";
import {
  HANDS_FREE_COPY,
  shownSpeechMode,
  type SpeechReadMode,
} from "@t3tools/client-runtime/speech";
import type { MessageId, ScopedThreadRef } from "@t3tools/contracts";
import { memo } from "react";
import { AccessibilityInfo, Pressable, View, type ColorValue } from "react-native";

import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { type AppSymbolName, SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import * as Dialog from "../../components/ui/Dialog";
import { SegmentedControl } from "../../components/ui/SegmentedControl";
import { openSettings } from "../settings/settings-navigation";
import {
  SPEECH_SKIP_SECONDS,
  SpeechNotConfiguredError,
  type SpeechRequest,
  seekSpeech,
  speakMessage,
  stopSpeech,
  toggleSpeechPause,
  useSpeechPlayback,
} from "./speechPlayback";
import { currentSpeechSettings, useSpeechSettings } from "./speechSettings";
import { loadSpokenSummary, noteSpokenSummaryFailure, useCanSummarize } from "./spokenSummary";

const WRITING_SHORT_LABEL = "Writing short version";
/** The full reply had already ended, so nothing reads it instead. */
const SHORT_UNAVAILABLE_ENDED = "The short version isn't available.";
const READ_MODE_OPTIONS = [
  { value: "short", label: "Short", accessibilityLabel: "Short version" },
  { value: "full", label: "Full", accessibilityLabel: "Full reply" },
] as const;

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

function TextButton(props: { readonly label: string; readonly onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      hitSlop={6}
      onPress={props.onPress}
      className="h-7 justify-center px-1.5"
      style={({ pressed }) => ({ opacity: pressed ? 0.52 : 1 })}
    >
      <Text className="font-t3-medium text-xs text-foreground-secondary">{props.label}</Text>
    </Pressable>
  );
}

/**
 * What reading a reply plays. Replies of a server thread can be read as its spoken summary;
 * drafts, and threads this connection may not summarize, always play in full.
 */
export function replySpeechRequest(input: {
  readonly messageId: MessageId;
  readonly markdown: string;
  readonly title: string;
  readonly threadRef: ScopedThreadRef | null;
  readonly mode: SpeechReadMode | undefined;
}): SpeechRequest {
  const { threadRef, messageId } = input;
  return {
    messageId,
    markdown: input.markdown,
    title: input.title,
    mode: input.mode ?? currentSpeechSettings().readMode,
    ...(threadRef
      ? {
          loadSummary: () => loadSpokenSummary({ ...threadRef, messageId }),
          // Passive reads tell once per environment; a switch to Short always gets an answer.
          onShortUnavailable: (error: unknown, chosen: boolean, readingFull: boolean) => {
            const tell = noteSpokenSummaryFailure(threadRef.environmentId, error) || chosen;
            if (tell) {
              AccessibilityInfo.announceForAccessibility(
                readingFull ? HANDS_FREE_COPY.shortUnavailable : SHORT_UNAVAILABLE_ENDED,
              );
            }
            return tell;
          },
        }
      : {}),
  };
}

export interface ReplyToRead {
  readonly messageId: MessageId;
  readonly markdown: string;
  readonly title: string;
  /** The server thread of the reply; null for a thread still being created. */
  readonly threadRef: ScopedThreadRef | null;
}

/**
 * Starts reading a reply, explaining setup and failures. `enabled` is false when read aloud is
 * turned off in settings; with no provider yet, starting leads to setup.
 */
export function useReadReplyAloud(reply: ReplyToRead) {
  const navigation = useNavigation();
  const settings = useSpeechSettings();
  const canSummarize = useCanSummarize(reply.threadRef?.environmentId ?? null);
  const start = (mode?: SpeechReadMode) => {
    speakMessage(
      replySpeechRequest({ ...reply, threadRef: canSummarize ? reply.threadRef : null, mode }),
    ).catch((error: unknown) => {
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
  const enabled = settings.providers.length === 0 || Boolean(settings.activeProviderId);
  return { enabled, start };
}

/** Reads an assistant message aloud; expands into transport controls while it is loaded. */
export const SpeakMessageButton = memo(function SpeakMessageButton(
  props: ReplyToRead & {
    readonly tintColor: ColorValue;
    readonly buttonSize?: number;
    readonly iconSize?: number;
  },
) {
  const playback = useSpeechPlayback(props.messageId);
  const { enabled, start } = useReadReplyAloud(props);
  const size = props.buttonSize ?? 28;
  const iconSize = props.iconSize ?? 13;

  if (playback.phase === "idle" && !enabled) return null;

  const notice = playback.shortUnavailable ? (
    <Text className="px-1 text-xs text-foreground-secondary">
      {playback.phase === "idle" ? SHORT_UNAVAILABLE_ENDED : HANDS_FREE_COPY.shortUnavailable}
    </Text>
  ) : null;

  if (playback.phase === "idle") {
    const row = (
      <View className="flex-row items-center">
        <ControlButton
          icon="speaker.wave.2"
          label="Read aloud"
          tintColor={props.tintColor}
          size={size}
          iconSize={iconSize}
          disabled={props.markdown.trim().length === 0}
          onPress={() => start()}
        />
        {playback.fullOffer ? (
          <TextButton label="Read full reply" onPress={() => start("full")} />
        ) : null}
        {playback.fullOffer || playback.shortUnavailable ? (
          <ControlButton
            icon="xmark"
            label="Dismiss"
            tintColor={props.tintColor}
            size={size}
            iconSize={iconSize - 2}
            onPress={stopSpeech}
          />
        ) : null}
      </View>
    );
    return notice ? (
      <View>
        {row}
        {notice}
      </View>
    ) : (
      row
    );
  }

  const preparing = playback.phase === "preparing";
  const controls = (
    <View className="flex-row flex-wrap items-center">
      <ControlButton
        icon="gobackward.15"
        label={`Back ${SPEECH_SKIP_SECONDS} seconds`}
        tintColor={props.tintColor}
        size={size}
        iconSize={iconSize + 1}
        disabled={preparing}
        onPress={() => seekSpeech(-SPEECH_SKIP_SECONDS)}
      />
      {preparing || playback.buffering ? (
        <View
          accessible
          // "Writing short version" is shown as text beside it.
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
          onPress={toggleSpeechPause}
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
      {preparing ? (
        playback.writingShort ? (
          <Text className="ml-1 font-t3-medium text-xs text-foreground-secondary">
            {WRITING_SHORT_LABEL}
          </Text>
        ) : null
      ) : (
        <Text className="ml-1 font-t3-medium text-xs tabular-nums text-foreground-secondary">
          {formatTime(playback.currentTime)} / {formatTime(playback.duration)}
        </Text>
      )}
      {!preparing && playback.writingShort ? (
        <View accessible accessibilityLabel={WRITING_SHORT_LABEL} className="ml-1">
          <SymbolView name="clock" size={11} tintColor={props.tintColor} type="monochrome" />
        </View>
      ) : null}
      {playback.shortAvailable ? (
        <SegmentedControl
          className="ml-2 w-28"
          size="compact"
          options={READ_MODE_OPTIONS}
          selected={shownSpeechMode(playback)}
          onSelect={(mode) => {
            if (mode !== shownSpeechMode(playback)) start(mode);
          }}
        />
      ) : null}
    </View>
  );
  if (!notice) return controls;
  return (
    <View>
      {controls}
      {notice}
    </View>
  );
});
