import { describe, expect, it } from "vite-plus/test";

import { markdownToSpeechText, planSpeechChunks, splitSpeechText } from "./text.ts";

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

describe("planSpeechChunks", () => {
  const sentence = (n: number) => `Sentence number ${n} says a few words.`; // 37-38 chars

  it("keeps a short message in one request", () => {
    expect(planSpeechChunks("Short answer. Done.", [400, 800], 1500)).toEqual([
      "Short answer. Done.",
    ]);
  });

  it("starts with short pieces that end at sentences, then larger ones", () => {
    const text = Array.from({ length: 120 }, (_, n) => sentence(n)).join(" ");
    const chunks = planSpeechChunks(text, [400, 800], 1500);
    expect(chunks[0]!.length).toBeLessThanOrEqual(400);
    expect(chunks[0]!.length).toBeGreaterThan(300);
    expect(chunks[0]).toMatch(/words\.$/);
    expect(chunks[1]!.length).toBeLessThanOrEqual(800);
    expect(chunks[1]!.length).toBeGreaterThan(700);
    expect(chunks[1]).toMatch(/^Sentence number \d+ says/);
    for (const chunk of chunks.slice(2)) expect(chunk.length).toBeLessThanOrEqual(1500);
    expect(chunks[2]!.length).toBeGreaterThan(1400);
    expect(chunks.join(" ")).toBe(text);
  });

  it("falls back to a word boundary when a sentence is too long", () => {
    const text = `${"word ".repeat(200)}end`;
    const chunks = planSpeechChunks(text, [50], 1500);
    expect(chunks[0]).toBe("word ".repeat(10).trim());
    expect(chunks.join(" ")).toBe(text);
  });
});
