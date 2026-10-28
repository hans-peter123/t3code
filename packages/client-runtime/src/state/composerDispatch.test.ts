import { describe, expect, it } from "vite-plus/test";

import { resolveFollowUpDispatchMode } from "./composerDispatch.ts";

describe("resolveFollowUpDispatchMode", () => {
  const idle = { running: false, setupRunning: false, canSteer: true } as const;
  it.each([
    {
      name: "nothing runs: a new turn",
      input: { ...idle, activeTurnDefault: "steer" },
      mode: null,
    },
    {
      name: "a run being set up: queued, even to steer",
      input: { ...idle, running: true, setupRunning: true, activeTurnDefault: "steer" },
      mode: "queue",
    },
    {
      name: "steering a running turn travels as auto",
      input: { ...idle, running: true, activeTurnDefault: "steer" },
      mode: "auto",
    },
    {
      name: "queueing behind a running turn",
      input: { ...idle, running: true, activeTurnDefault: "queue" },
      mode: "queue",
    },
    {
      name: "a turn that cannot be steered: a new turn, as the composer sends it",
      input: { ...idle, running: true, canSteer: false, activeTurnDefault: "steer" },
      mode: null,
    },
  ] as const)("$name", ({ input, mode }) => {
    expect(resolveFollowUpDispatchMode(input)).toBe(mode);
  });
});
