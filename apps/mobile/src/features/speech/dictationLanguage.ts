import { languageSample, resolveDictationLocale } from "@t3tools/client-runtime/speech";

import { VoiceCapture } from "../../native/voiceCapture";
import { currentSpeechSettings } from "./speechSettings";

/** What dictation knows about the thread it writes into. */
export interface DictationContext {
  /** The user's messages in the thread, oldest first. */
  readonly userMessages: () => readonly string[];
}

export interface DictationLocaleChoice {
  readonly id: string;
  readonly name: string;
}

// Offered where there is no on-device recognizer to list its own locales.
const FALLBACK_LOCALES = [
  "ar-SA",
  "cs-CZ",
  "da-DK",
  "de-DE",
  "el-GR",
  "en-GB",
  "en-US",
  "es-ES",
  "es-MX",
  "fi-FI",
  "fr-FR",
  "he-IL",
  "hi-IN",
  "hu-HU",
  "id-ID",
  "it-IT",
  "ja-JP",
  "ko-KR",
  "nb-NO",
  "nl-NL",
  "pl-PL",
  "pt-BR",
  "pt-PT",
  "ro-RO",
  "ru-RU",
  "sv-SE",
  "th-TH",
  "tr-TR",
  "uk-UA",
  "vi-VN",
  "zh-CN",
  "zh-TW",
];

let locales: Promise<readonly DictationLocaleChoice[]> | null = null;

/** Languages dictation can be set to, sorted by name. */
export function dictationLocaleChoices(): Promise<readonly DictationLocaleChoice[]> {
  locales ??= (
    VoiceCapture
      ? VoiceCapture.dictationLocales(FALLBACK_LOCALES).catch(() => [])
      : Promise.resolve([])
  ).then((choices) =>
    // Hermes lacks toSorted.
    [...(choices.length > 0 ? choices : FALLBACK_LOCALES.map((id) => ({ id, name: id })))].sort(
      (a, b) => a.name.localeCompare(b.name),
    ),
  );
  return locales;
}

function deviceLocale(): string {
  return Intl.DateTimeFormat().resolvedOptions().locale;
}

function detectThreadLanguage(context: DictationContext | null): string | null {
  if (!context || !VoiceCapture) return null;
  const sample = languageSample(context.userMessages());
  if (!sample) return null;
  try {
    return VoiceCapture.detectLanguage(sample);
  } catch {
    return null;
  }
}

async function installedDictationLocales(): Promise<readonly string[]> {
  return VoiceCapture ? VoiceCapture.installedDictationLocales().catch(() => []) : [];
}

/**
 * Locales Apple's on-device recognizer tries in order: the chosen one, or the thread's language
 * and then the device locale, so a detection the recognizer cannot serve still dictates.
 * A detected language counts only when its model is installed: preparing a missing one downloads
 * it before the microphone opens, for a language the user never picked.
 */
export async function onDeviceDictationLocales(
  context: DictationContext | null,
): Promise<readonly string[]> {
  const preference = currentSpeechSettings().dictationLanguage;
  if (preference) return [preference];
  const detected = detectThreadLanguage(context);
  const device = deviceLocale();
  const locale = resolveDictationLocale({
    preference,
    detected,
    deviceLocale: device,
    supported: detected ? await installedDictationLocales() : [],
  });
  return locale === device ? [device] : [locale, device];
}

/**
 * The language a cloud provider transcribes in: only a chosen one. Under Automatic the provider
 * hears the language of each recording itself, which a thread's language would override.
 */
export function providerDictationLanguage(): string | null {
  return currentSpeechSettings().dictationLanguage;
}

/** Display name of a dictation locale; the tag itself until the list has loaded. */
export function dictationLocaleName(
  choices: readonly DictationLocaleChoice[] | null,
  id: string,
): string {
  return choices?.find((choice) => choice.id === id)?.name ?? id;
}
