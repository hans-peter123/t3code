import { describe, expect, it } from "vite-plus/test";

import { compactionBlocksSteering, resolveFollowUpDispatchMode } from "./composerDispatch.ts";

it("blocks steering for explicit compaction, and for automatic compaction unless the provider takes steers then", () => {
  const during = (
    text: string | undefined,
    attachments: ReadonlyArray<unknown> = [],
    steersDuringCompaction = true,
  ) =>
    compactionBlocksSteering({
      compactCommandIsActive: false,
      compactionRunning: true,
      steersDuringCompaction,
      run: { userMessageId: "user" },
      messages: [
        ...(text === undefined ? [] : [{ id: "user", text, attachments }]),
        { id: "later", text: "/compact" },
      ],
    });

  for (const text of ["/compact", "  /COMPACT  ", "/compact keep the debugging notes"]) {
    expect(during(text)).toBe(true);
  }
  for (const text of ["Read the code", "/compactify", "please /compact", undefined]) {
    expect(during(text)).toBe(false);
  }
  expect(during("/compact", [{}])).toBe(false);
  expect(during("Read the code", [], false)).toBe(true);

  expect(
    compactionBlocksSteering({
      compactCommandIsActive: true,
      compactionRunning: false,
      steersDuringCompaction: true,
      run: undefined,
      messages: undefined,
    }),
  ).toBe(true);
  expect(
    compactionBlocksSteering({
      compactCommandIsActive: false,
      compactionRunning: false,
      steersDuringCompaction: false,
      run: { userMessageId: "user" },
      messages: [{ id: "user", text: "/compact" }],
    }),
  ).toBe(false);
});

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
