import * as Clipboard from "expo-clipboard";
import { useEffect, useRef, useState } from "react";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/ui/AppText";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { SettingsSection } from "../settings/components/SettingsSection";
import { HandsFreeProbe, type ProbePhase } from "./handsFreeProbe";

const PHASE_LABELS: Record<ProbePhase, string> = {
  off: "Off",
  speaking: "Speaking",
  listening: "Listening – press Done when finished",
  transcribing: "Transcribing",
  waiting: "Waiting in silence (agent at work)",
};

/** Temporary device test for the hands-free mode; removed once the real mode ships. */
export function SettingsHandsFreeProbeRouteScreen() {
  const insets = useSafeAreaInsets();
  const [phase, setPhase] = useState<ProbePhase>("off");
  const [lines, setLines] = useState<readonly string[]>([]);
  const probe = useRef<HandsFreeProbe | null>(null);
  probe.current ??= new HandsFreeProbe((line) => {
    const time = new Date().toLocaleTimeString([], { hour12: false });
    setLines((current) => [...current, `${time} ${line}`].slice(-200));
  }, setPhase);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- releases the audio session and microphone when leaving the test.
  useEffect(() => () => void probe.current?.stop(), []);

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        className="flex-1"
        contentContainerClassName="gap-5 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        <SettingsSection
          title={PHASE_LABELS[phase]}
          footer="Start, lock the iPhone, and talk. Finish with the lock screen pause button or a tap on your AirPods. Wait the full 30 seconds while locked. Try both tests, then copy the log."
        >
          {phase === "off" ? (
            <>
              <ListActionRow
                icon="play"
                label="Start test: continuous microphone"
                onPress={() => void probe.current?.start("continuous")}
              />
              <ListActionRow
                icon="play"
                label="Start test: recording per round"
                onPress={() => void probe.current?.start("recorder")}
              />
            </>
          ) : (
            <>
              <ListActionRow
                icon="checkmark"
                label={phase === "speaking" ? "Skip" : "Done"}
                disabled={phase !== "listening" && phase !== "speaking"}
                onPress={() => probe.current?.remotePress()}
              />
              <ListActionRow
                icon="stop.fill"
                label="Stop test"
                tone="danger"
                onPress={() => void probe.current?.stop()}
              />
            </>
          )}
          <ListActionRow
            icon="doc.on.doc"
            label="Copy log"
            disabled={lines.length === 0}
            onPress={() => void Clipboard.setStringAsync(lines.join("\n"))}
          />
        </SettingsSection>
        <SettingsSection title="Log">
          <Text selectable className="px-4 py-3 font-mono text-xs text-foreground-muted">
            {lines.length === 0 ? "Nothing yet." : lines.join("\n")}
          </Text>
        </SettingsSection>
      </ScrollView>
    </View>
  );
}
