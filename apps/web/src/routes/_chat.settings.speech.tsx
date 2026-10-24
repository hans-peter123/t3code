import { createFileRoute } from "@tanstack/react-router";
import { VoiceSettingsPanel as SpeechSettingsPanel } from "../components/settings/VoiceSettings";

export const Route = createFileRoute("/_chat/settings/speech")({
  component: SpeechSettingsPanel,
});
