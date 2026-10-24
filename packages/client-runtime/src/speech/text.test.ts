import { describe, expect, it } from "vite-plus/test";

import { markdownToSpeechText, splitSpeechText } from "./text.ts";

describe("markdownToSpeechText", () => {
  it("drops code blocks, images, and markup but keeps readable text", () => {
    const markdown = [
      "## Summary",
      "",
      "I updated **two files** and the `parser` [docs](https://example.com).",
      "",
      "```ts",
      "const x = 1;",
      "```",
      "",
      "- First item",
      "1. Second item",
      "> Quoted _note_",
      "![diagram](image.png)",
    ].join("\n");
    expect(markdownToSpeechText(markdown)).toBe(
      "Summary\n\nI updated two files and the parser docs.\n\nFirst item\nSecond item\nQuoted note",
    );
  });

  it("drops an unterminated code fence", () => {
    expect(markdownToSpeechText("Before\n```\nhalf a block")).toBe("Before");
  });

  it("reads table rows as comma-separated cells", () => {
    expect(markdownToSpeechText("| A | B |\n| --- | --- |\n| 1 | 2 |")).toBe("A, B\n1, 2");
  });

  it("keeps snake_case words intact", () => {
    expect(markdownToSpeechText("Set max_tokens and _really_ check")).toBe(
      "Set max_tokens and really check",
    );
  });
});

describe("splitSpeechText", () => {
  it("keeps short text in one piece", () => {
    expect(splitSpeechText("One.\n\nTwo.", 100)).toEqual(["One.\n\nTwo."]);
  });

  it("splits at paragraphs, then sentences, within the limit", () => {
    const chunks = splitSpeechText("Alpha beta. Gamma delta.\n\nEpsilon zeta.", 14);
    expect(chunks).toEqual(["Alpha beta.", "Gamma delta.", "Epsilon zeta."]);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(14);
  });

  it("breaks a word longer than the limit", () => {
    expect(splitSpeechText("abcdefghij", 4)).toEqual(["abcd", "efgh", "ij"]);
  });
});
