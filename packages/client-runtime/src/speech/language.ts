import { markdownToSpeechText } from "./text.ts";

const SAMPLE_MESSAGES = 6;
const SAMPLE_LENGTH = 1_200;

/** The language of a locale tag, e.g. "de" for "de-DE": what transcription APIs accept. */
export function localeLanguage(locale: string): string {
  return locale.split(/[-_]/)[0]!.toLowerCase();
}

function localeRegion(locale: string): string | null {
  const region = locale.split(/[-_]/).find((part, index) => index > 0 && /^[A-Z]{2}$/i.test(part));
  return region?.toUpperCase() ?? null;
}

/**
 * The user's latest messages in a thread as prose to detect its language from. Code and
 * markup are dropped: they read as English whatever language the user writes in.
 */
export function languageSample(userMessages: readonly string[]): string {
  return userMessages
    .slice(-SAMPLE_MESSAGES)
    .map(markdownToSpeechText)
    .filter((text) => text.length > 0)
    .join("\n")
    .slice(-SAMPLE_LENGTH);
}

/**
 * The locale dictation listens for. A chosen language wins. Otherwise the thread's detected
 * language, in the device's region when the recognizer offers it, then any of its locales;
 * the device locale when nothing was detected, the recognizer lacks that language, or the device
 * already speaks it.
 */
export function resolveDictationLocale(input: {
  readonly preference: string | null;
  /** A language or locale detected from the thread, e.g. "de". */
  readonly detected: string | null;
  readonly deviceLocale: string;
  /** Locales the recognizer supports; empty when unknown. */
  readonly supported: readonly string[];
}): string {
  if (input.preference) return input.preference;
  const { detected, deviceLocale } = input;
  if (!detected || localeLanguage(detected) === localeLanguage(deviceLocale)) return deviceLocale;
  const language = localeLanguage(detected);
  const candidates = input.supported.filter((locale) => localeLanguage(locale) === language);
  const region = localeRegion(deviceLocale);
  return (
    candidates.find((locale) => region !== null && localeRegion(locale) === region) ??
    candidates.find((locale) => localeRegion(locale) === localeRegion(detected)) ??
    candidates[0] ??
    deviceLocale
  );
}
