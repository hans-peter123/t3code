import { randomUUID } from "expo-crypto";
import {
  newSpeechProvider,
  withSpeechProviderAdded,
  withSpeechProviderRemoved,
} from "@t3tools/client-runtime/speech";
import { ActionSheetIOS, Alert } from "react-native";

import * as Dialog from "../../components/ui/Dialog";
import { setSpeechPlaybackRate, speakMessage, stopSpeech } from "./speechPlayback";
import {
  SPEECH_PROVIDER_KINDS,
  type SpeechProviderConfig,
  type SpeechProviderKind,
  updateSpeechSettings,
} from "./speechSettings";

export type SpeechRole = "readAloud" | "dictation";

export function providerLabel(provider: SpeechProviderConfig): string {
  return provider.name.trim() || SPEECH_PROVIDER_KINDS[provider.kind].label;
}

const KEY_PAGES: Partial<Record<SpeechProviderKind, string>> = {
  openai: "platform.openai.com/api-keys",
  elevenlabs: "elevenlabs.io/app/settings/api-keys",
};

/** Asks for an API key in a secure prompt; an empty answer counts as cancelling. */
export function promptForApiKey(kind: SpeechProviderKind, onKey: (apiKey: string) => void) {
  const page = KEY_PAGES[kind];
  Alert.prompt(
    `${SPEECH_PROVIDER_KINDS[kind].label} API key`,
    page ? `Create one at ${page}.` : "Only if your server asks for one.",
    [
      { text: "Cancel", style: "cancel" },
      {
        text: "Save",
        onPress: (value) => {
          const apiKey = value?.trim() ?? "";
          if (apiKey) onKey(apiKey);
        },
      },
    ],
    "secure-text",
  );
}

function promptForServerUrl(onUrl: (baseUrl: string) => void) {
  Alert.prompt(
    "Server URL",
    "The base URL of its OpenAI-compatible API, e.g. http://my-server:8880/v1.",
    [
      { text: "Cancel", style: "cancel" },
      {
        text: "Add",
        onPress: (value) => {
          const baseUrl = value?.trim() ?? "";
          if (/^https?:\/\/[^/\s]+/.test(baseUrl)) onUrl(baseUrl);
          else Dialog.alert("Not a server URL", "Start with http:// or https:// and a host name.");
        },
      },
    ],
    "plain-text",
    "",
    "url",
  );
}

const ADDABLE_KINDS: readonly SpeechProviderKind[] = ["openai", "elevenlabs", "openai-compatible"];

/**
 * Asks for what a provider of this kind cannot work without, then adds it, for `role` when one is
 * given. Cancelling adds nothing, so no half-made provider is left behind.
 */
export function startAddingProvider(
  role: SpeechRole | null,
  onAdded: (providerId: string) => void,
) {
  const add = (kind: SpeechProviderKind, patch: Partial<SpeechProviderConfig>) => {
    const provider = newSpeechProvider(randomUUID(), kind, patch);
    void updateSpeechSettings((current) => {
      const added = withSpeechProviderAdded(current, provider);
      if (role === "readAloud") return { ...added, activeProviderId: provider.id };
      // Added for dictation, it must not also start reading replies aloud.
      if (role === "dictation")
        return {
          ...added,
          activeProviderId: current.activeProviderId,
          transcriptionProviderId: provider.id,
        };
      return added;
    });
    onAdded(provider.id);
  };
  ActionSheetIOS.showActionSheetWithOptions(
    {
      title: "Add provider",
      options: [...ADDABLE_KINDS.map((kind) => SPEECH_PROVIDER_KINDS[kind].label), "Cancel"],
      cancelButtonIndex: ADDABLE_KINDS.length,
    },
    (index) => {
      const kind = ADDABLE_KINDS[index];
      if (kind === "openai-compatible") promptForServerUrl((baseUrl) => add(kind, { baseUrl }));
      else if (kind) promptForApiKey(kind, (apiKey) => add(kind, { apiKey }));
    },
  );
}

const SAMPLE_TEXT = "Hi! This is how T3 Code reads your messages aloud.";

export function sampleMessageId(provider: SpeechProviderConfig): string {
  return `sample:${provider.id}`;
}

/** Always starts the sample over, so a second tap never pauses it instead. */
export function playVoiceSample(provider: SpeechProviderConfig): Promise<void> {
  stopSpeech();
  return speakMessage({
    messageId: sampleMessageId(provider),
    markdown: SAMPLE_TEXT,
    title: "Voice sample",
    provider,
  }).catch((error: unknown) =>
    Dialog.alert(
      "Could not play the sample",
      error instanceof Error ? error.message : "Try again.",
    ),
  );
}

export function editProvider(id: string, patch: Partial<SpeechProviderConfig>) {
  void updateSpeechSettings((current) => ({
    ...current,
    providers: current.providers.map((provider) =>
      provider.id === id ? { ...provider, ...patch } : provider,
    ),
  }));
}

export function removeProvider(id: string) {
  stopSpeech();
  void updateSpeechSettings((current) => withSpeechProviderRemoved(current, id));
}

/** Null turns read aloud off, or hands dictation back to the iPhone. */
export function assignRole(role: SpeechRole, providerId: string | null) {
  void updateSpeechSettings((current) =>
    role === "readAloud"
      ? { ...current, activeProviderId: providerId }
      : { ...current, transcriptionProviderId: providerId },
  );
}

export function setPlaybackRate(playbackRate: number) {
  setSpeechPlaybackRate(playbackRate);
  void updateSpeechSettings((current) => ({ ...current, playbackRate }));
}
