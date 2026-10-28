import AppleTranscription from "@react-native-ai/apple/src/NativeAppleTranscription";
import { File } from "expo-file-system";

import {
  VoiceTranscriptionError,
  throwIfVoiceTranscriptionAborted,
  type PreparedVoiceTranscription,
  type VoiceTranscriber,
  type VoiceTranscriptionOptions,
} from "@t3tools/client-runtime/voice-input";

function getDeviceLocale(): string {
  return Intl.DateTimeFormat().resolvedOptions().locale;
}

function wrapError(
  code: "preparation-failed" | "transcription-failed",
  message: string,
  cause: unknown,
): VoiceTranscriptionError {
  if (cause instanceof VoiceTranscriptionError) {
    return cause;
  }

  return new VoiceTranscriptionError(code, message, { cause });
}

function getNativeErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }

  return typeof error.code === "string" ? error.code : undefined;
}

/**
 * `resolveLocales` lists the locales to listen for, best first; availability does not depend on
 * them. A locale the recognizer cannot serve gives way to the next one.
 */
export function getLocalVoiceTranscriber(
  resolveLocales: () => Promise<readonly string[]>,
): VoiceTranscriber | null {
  if (!AppleTranscription.isAvailable(getDeviceLocale())) return null;
  return { prepare: (options) => prepareVoiceTranscription(resolveLocales, options) };
}

async function prepareVoiceTranscription(
  resolveLocales: () => Promise<readonly string[]>,
  { signal }: VoiceTranscriptionOptions,
): Promise<PreparedVoiceTranscription> {
  throwIfVoiceTranscriptionAborted(signal);
  const resolved = await resolveLocales().catch(() => []);
  throwIfVoiceTranscriptionAborted(signal);
  const locales = resolved.length > 0 ? resolved : [getDeviceLocale()];
  let failure: unknown;
  for (const locale of locales) {
    try {
      return await prepareLocale(locale, signal);
    } catch (error) {
      throwIfVoiceTranscriptionAborted(signal);
      failure = error;
    }
  }
  throw failure;
}

async function prepareLocale(
  locale: string,
  signal: AbortSignal,
): Promise<PreparedVoiceTranscription> {
  if (!AppleTranscription.isAvailable(locale)) {
    throw new VoiceTranscriptionError(
      "unavailable",
      "Voice transcription requires a supported device with iOS 26 or later.",
    );
  }

  try {
    const supportedLocale = await AppleTranscription.prepare(locale);
    throwIfVoiceTranscriptionAborted(signal);
    return {
      locale: supportedLocale,
      transcribe: (uri, options) => transcribeVoiceRecording(uri, supportedLocale, options),
    };
  } catch (error) {
    throwIfVoiceTranscriptionAborted(signal);
    if (getNativeErrorCode(error) === "AppleTranscriptionUnsupportedLocale") {
      throw new VoiceTranscriptionError(
        "unsupported-locale",
        "Voice transcription does not support this device language.",
        { cause: error },
      );
    }

    throw wrapError(
      "preparation-failed",
      "Voice transcription could not prepare this language.",
      error,
    );
  }
}

async function transcribeVoiceRecording(
  uri: string,
  locale: string,
  { signal }: VoiceTranscriptionOptions,
): Promise<string> {
  try {
    throwIfVoiceTranscriptionAborted(signal);
    const audio = await new File(uri).arrayBuffer();
    throwIfVoiceTranscriptionAborted(signal);
    const result = await AppleTranscription.transcribe(audio, locale);
    throwIfVoiceTranscriptionAborted(signal);
    return result.segments
      .map((segment) => segment.text)
      .join(" ")
      .trim();
  } catch (error) {
    throwIfVoiceTranscriptionAborted(signal);
    throw wrapError("transcription-failed", "Voice transcription failed.", error);
  }
}
