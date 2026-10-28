import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import {
  HANDS_FREE_COPY,
  type HandsFreeState,
  type HandsFreeThreadRequest,
  type SpeechReadMode,
} from "@t3tools/client-runtime/speech";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useKeepAwake } from "expo-keep-awake";
import { Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { IconButton } from "../../components/ui/IconButton";
import { Notice } from "../../components/ui/Notice";
import { SegmentedControl } from "../../components/ui/SegmentedControl";
import { useCanSummarize } from "../speech/spokenSummary";
import { conversation, useConversation } from "./conversation";
import { startConversation } from "./startConversation";

const READ_MODE_OPTIONS = [
  { value: "short", label: "Short", accessibilityLabel: "Short version" },
  { value: "full", label: "Full", accessibilityLabel: "Full reply" },
] as const;

/** The big words a driver reads at a glance, and the hint under them. */
function describe(
  state: HandsFreeState,
  interrupted: boolean,
  request: HandsFreeThreadRequest | null,
): [string, string | null] {
  if (interrupted && state.phase.kind !== "off") {
    return ["Paused", "The conversation goes on after the call."];
  }
  const { phase } = state;
  switch (phase.kind) {
    case "speaking": {
      const { speech } = phase;
      if (speech.kind === "reply") {
        return [
          speech.mode === "short" ? "Reading the short version" : "Reading the reply",
          "Tap to talk instead.",
        ];
      }
      return [speech.kind === "noReply" ? HANDS_FREE_COPY.noReply : speech.text, null];
    }
    case "tone":
    case "listening":
      return ["Listening", "Press Done when you finish. AirPods and the lock screen work too."];
    case "transcribing":
      return ["Transcribing", null];
    case "sending":
      return ["Sending", null];
    case "waiting":
      if (state.held) {
        return [
          "Paused",
          state.pending.length > 0
            ? "The audio device disconnected. Tap Talk to hear the reply."
            : "The audio device disconnected. Tap Talk to go on.",
        ];
      }
      if (request) {
        return [
          request.kind === "approval" ? "Waiting for your approval" : "The agent has a question",
          "Answer it on screen. Tap Talk to queue a message.",
        ];
      }
      return [
        state.agentWorking ? "The agent is working" : "Waiting",
        "You hear the reply when it is ready. Tap Talk to say more.",
      ];
    case "unsent":
      return ["Your message wasn't sent", "Press Send again, or record it again."];
    case "off":
      return ["Conversation ended", null];
  }
}

function primaryLabel(state: HandsFreeState): { label: string; enabled: boolean } {
  switch (state.phase.kind) {
    case "speaking":
      return state.phase.then === "unsent"
        ? { label: "Send again", enabled: true }
        : { label: "Skip", enabled: true };
    case "listening":
      return { label: "Done", enabled: true };
    case "waiting":
      return { label: "Talk", enabled: true };
    case "unsent":
      return { label: "Send again", enabled: true };
    case "tone":
      return { label: "Done", enabled: true };
    case "transcribing":
      return { label: "Transcribing", enabled: false };
    case "sending":
      return { label: "Sending", enabled: false };
    case "off":
      return { label: "Done", enabled: false };
  }
}

const canRedo = (state: HandsFreeState) =>
  state.phase.kind === "listening" ||
  state.phase.kind === "unsent" ||
  (state.phase.kind === "speaking" && state.phase.then === "unsent");

function KeepAwake() {
  useKeepAwake("hands-free-conversation");
  return null;
}

type ConversationRouteScreenProps = StaticScreenProps<{
  readonly environmentId: string;
  readonly threadId: string;
}>;

/** Full screen while talking with a thread: big state, a big Done, and End. */
export function ConversationRouteScreen({ route }: ConversationRouteScreenProps) {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const view = useConversation();
  const ref = {
    environmentId: EnvironmentId.make(route.params.environmentId),
    threadId: ThreadId.make(route.params.threadId),
  };
  const canSummarize = useCanSummarize(ref.environmentId);
  const running =
    view.state.phase.kind !== "off" &&
    view.ref?.environmentId === ref.environmentId &&
    view.ref.threadId === ref.threadId;
  const state = running ? view.state : { ...view.state, phase: { kind: "off" } as const };
  const [headline, hint] = describe(state, running && view.interrupted, view.request);
  const notice =
    view.notice?.ref.environmentId === ref.environmentId &&
    view.notice.ref.threadId === ref.threadId
      ? view.notice.text
      : null;
  const primary = primaryLabel(state);
  const close = () => navigation.goBack();

  return (
    <View
      className="flex-1 bg-screen px-6"
      style={{ paddingTop: insets.top + 8, paddingBottom: Math.max(insets.bottom, 16) + 8 }}
    >
      {running ? <KeepAwake /> : null}
      <View className="flex-row items-center gap-3">
        <IconButton accessibilityLabel="Close" icon="chevron.down" onPress={close} />
        <Text className="min-w-0 flex-1 text-base text-foreground-muted" numberOfLines={1}>
          {view.title}
        </Text>
      </View>

      {/* Scrolls at large text sizes so the controls below stay on screen. */}
      <ScrollView
        className="flex-1"
        contentContainerClassName="flex-grow justify-center gap-4 py-4"
      >
        <Text
          accessibilityRole="header"
          accessibilityLiveRegion="polite"
          className="font-t3-bold text-4xl text-foreground"
          maxFontSizeMultiplier={1.3}
        >
          {headline}
        </Text>
        {hint ? <Text className="text-lg text-foreground-muted">{hint}</Text> : null}
        {running && view.microphoneError ? (
          <Notice message={view.microphoneError} tone="danger" />
        ) : null}
        {notice ? (
          <Notice
            message={notice}
            onDismiss={() => conversation.dismissNotice()}
            dismissLabel="Dismiss"
          />
        ) : null}
      </ScrollView>

      {running ? (
        <View className="gap-4">
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ disabled: !primary.enabled }}
            disabled={!primary.enabled}
            onPress={() => conversation.press()}
            className={
              primary.enabled
                ? "min-h-40 items-center justify-center rounded-[36px] bg-primary px-4 py-6 active:opacity-70"
                : "min-h-40 items-center justify-center rounded-[36px] bg-subtle-strong px-4 py-6"
            }
          >
            <Text
              maxFontSizeMultiplier={1.3}
              className={
                primary.enabled
                  ? "font-t3-bold text-5xl text-primary-foreground"
                  : "font-t3-bold text-5xl text-foreground-muted"
              }
            >
              {primary.label}
            </Text>
          </Pressable>
          {canRedo(state) ? (
            <View className="flex-row gap-3">
              <View className="flex-1">
                <Button
                  label="Discard"
                  icon="trash"
                  fullWidth
                  onPress={() => conversation.send({ type: "discard" })}
                />
              </View>
              <View className="flex-1">
                <Button
                  label="Re-record"
                  icon="arrow.clockwise"
                  fullWidth
                  onPress={() => conversation.send({ type: "rerecord" })}
                />
              </View>
            </View>
          ) : null}
          {canSummarize ? (
            <SegmentedControl
              options={READ_MODE_OPTIONS}
              selected={state.readMode}
              onSelect={(readMode: SpeechReadMode) =>
                conversation.send({ type: "setReadMode", readMode })
              }
            />
          ) : null}
          <Button
            label="End conversation"
            tone="danger"
            fullWidth
            onPress={() => {
              void conversation.stop();
              close();
            }}
          />
        </View>
      ) : (
        <View className="gap-3">
          <Button
            label="Start conversation"
            icon="headphones"
            tone="primary"
            fullWidth
            onPress={() => void startConversation(ref, false)}
          />
          <Button label="Close" fullWidth onPress={close} />
        </View>
      )}
    </View>
  );
}
