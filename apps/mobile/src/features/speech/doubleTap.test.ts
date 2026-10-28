import { describe, expect, it } from "vite-plus/test";

import { createDoubleTapDetector, hasBlockquote } from "./doubleTap";

type Tap = readonly [x: number, y: number, down: number, up: number, upX?: number];

function taps(sequence: ReadonlyArray<Tap | "cancel" | "pinch" | "stopsScroll">): boolean[] {
  const detector = createDoubleTapDetector();
  const results: boolean[] = [];
  for (const step of sequence) {
    if (step === "cancel") detector.cancel();
    else if (step === "pinch") detector.start({ x: 0, y: 0, time: 0 }, 2);
    else if (step === "stopsScroll") {
      detector.start({ x: 0, y: 0, time: 100 }, 1, false);
      results.push(detector.end({ x: 0, y: 0, time: 140 }));
    } else {
      const [x, y, down, up, upX = x] = step;
      detector.start({ x, y, time: down }, 1);
      results.push(detector.end({ x: upX, y, time: up }));
    }
  }
  return results;
}

describe("createDoubleTapDetector", () => {
  it.each([
    [
      "two quick taps in place",
      [
        [10, 10, 0, 60],
        [12, 11, 200, 260],
      ],
      [false, true],
    ],
    [
      "a third tap starts over",
      [
        [0, 0, 0, 50],
        [0, 0, 150, 200],
        [0, 0, 300, 350],
      ],
      [false, true, false],
    ],
    [
      "taps too far apart in time",
      [
        [0, 0, 0, 50],
        [0, 0, 400, 450],
      ],
      [false, false],
    ],
    [
      "taps in different places",
      [
        [0, 0, 0, 50],
        [80, 0, 150, 200],
      ],
      [false, false],
    ],
    [
      "a long press then a tap",
      [
        [0, 0, 0, 400],
        [0, 0, 500, 550],
      ],
      [false, false],
    ],
    [
      "a drag then a tap",
      [
        [0, 0, 0, 50, 40],
        [40, 0, 150, 200],
      ],
      [false, false],
    ],
    ["a scroll cancels between taps", [[0, 0, 0, 50], "cancel", [0, 0, 150, 200]], [false, false]],
    ["a second finger resets", [[0, 0, 0, 50], "pinch", [0, 0, 150, 200]], [false, false]],
    ["a tap that stops the list, then a tap", ["stopsScroll", [0, 0, 200, 250]], [false, false]],
    ["a tap, then one that stops the list", [[0, 0, 0, 50], "stopsScroll"], [false, false]],
  ] as const)("%s", (_name, sequence, expected) => {
    expect(taps(sequence)).toEqual(expected);
  });
});

describe("hasBlockquote", () => {
  it.each([
    ["a quote line", "Hi\n\n> you said this", true],
    ["an admonition", "> [!NOTE]\n> Careful", true],
    ["an indented quote", "   > quoted", true],
    ["plain text", "a > b\n    > indented code", false],
    ["a REPL prompt in fenced code", "```python\n>>> 1 + 1\n```", false],
    ["a quote after a closed fence", "~~~\n> shell\n~~~\n> real quote", true],
    ["a shorter fence that does not close", "````\n```\n> still code\n````", false],
  ])("%s", (_name, markdown, expected) => {
    expect(hasBlockquote(markdown)).toBe(expected);
  });
});
