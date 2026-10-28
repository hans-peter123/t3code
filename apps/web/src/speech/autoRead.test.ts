import { describe, expect, it } from "vite-plus/test";

import type { ChatMessage } from "../types";
import { type AutoReadCursor, nextAutoRead } from "./autoRead";

function reply(id: string, runId: string, patch: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id,
    role: "assistant",
    text: `Reply ${id}`,
    runId,
    streaming: false,
    createdAt: "2026-10-28T00:00:00.000Z",
    updatedAt: "2026-10-28T00:00:00.000Z",
    ...patch,
  } as ChatMessage;
}

function step(
  cursor: AutoReadCursor | null,
  runId: string | null,
  settled: boolean,
  messages: readonly ChatMessage[],
  threadKey = "t1",
) {
  return nextAutoRead(cursor, { threadKey, runId, settled, messages });
}

describe("nextAutoRead", () => {
  it("passes over a reply that was already finished when the thread opened", () => {
    const opened = step(null, "r1", true, [reply("a", "r1")]);
    expect(opened.reply).toBeNull();
    expect(step(opened.cursor, "r1", true, [reply("a", "r1")]).reply).toBeNull();
  });

  it("reads the last reply of a run once it settles, and only once", () => {
    const running = step(null, "r2", false, [reply("a", "r1")]);
    const streaming = step(running.cursor, "r2", true, [
      reply("a", "r1"),
      reply("b", "r2", { streaming: true }),
    ]);
    expect(streaming.reply).toBeNull();
    const done = step(streaming.cursor, "r2", true, [
      reply("a", "r1"),
      reply("b", "r2"),
      reply("c", "r2"),
    ]);
    expect(done.reply?.id).toBe("c");
    expect(step(done.cursor, "r2", true, [reply("c", "r2")]).reply).toBeNull();
  });

  it("never reads an earlier run's reply for a run that wrote none", () => {
    const opened = step(null, "r1", true, [reply("a", "r1")]);
    const next = step(opened.cursor, "r2", true, [reply("a", "r1")]);
    expect(next.reply).toBeNull();
  });

  it("starts over on another thread, waiting until its run id is known", () => {
    const first = step(null, "r1", false, [], "t1");
    const loading = step(first.cursor, null, true, [], "t2");
    const loaded = step(loading.cursor, "x1", true, [reply("old", "x1")], "t2");
    expect(loaded.reply).toBeNull();
  });
});
