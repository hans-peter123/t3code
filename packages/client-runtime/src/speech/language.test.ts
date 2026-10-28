import { describe, expect, it } from "vite-plus/test";

import { languageSample, localeLanguage, resolveDictationLocale } from "./language.ts";

const supported = ["de-AT", "de-DE", "en-GB", "en-US", "fr-FR"];

describe("resolveDictationLocale", () => {
  it.each([
    ["a chosen language wins", { preference: "fr-FR", detected: "de" }, "fr-FR"],
    ["an English iPhone in Germany hears German threads in German", { detected: "de" }, "de-DE"],
    ["a thread in the device language keeps the device locale", { detected: "en" }, "en-DE"],
    ["nothing detected keeps the device locale", { detected: null }, "en-DE"],
    [
      "a language the device region lacks takes its first locale",
      { detected: "fr", deviceLocale: "en-US" },
      "fr-FR",
    ],
    ["a language the recognizer lacks keeps the device locale", { detected: "sv" }, "en-DE"],
  ])("%s", (_name, patch, expected) => {
    expect(
      resolveDictationLocale({
        preference: null,
        deviceLocale: "en-DE",
        supported,
        ...patch,
      }),
    ).toBe(expected);
  });
});

describe("languageSample", () => {
  it("keeps the latest messages without code", () => {
    const messages = ["Erste", ...Array.from({ length: 6 }, (_, index) => `Nachricht ${index}`)];
    const sample = languageSample([
      ...messages.slice(0, -1),
      "Bitte prüfen:\n\n```ts\nconst x = 1;\n```",
    ]);
    expect(sample).not.toContain("Erste");
    expect(sample).not.toContain("const");
    expect(sample).toContain("prüfen");
  });

  it("reads the language of a locale", () => {
    expect(localeLanguage("pt_BR")).toBe("pt");
  });
});
