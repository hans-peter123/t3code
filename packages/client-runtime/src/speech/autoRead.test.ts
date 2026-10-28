import { describe, expect, it } from "vite-plus/test";

import { type AutoReadCursor, type AutoReadMessage, nextAutoRead } from "./autoRead.ts";

interface Message extends AutoReadMessage {
  readonly id: string;
}

function reply(id: string, runId: string, patch: Partial<Message> = {}): Message {
  return { id, role: "assistant", text: `Reply ${id}`, runId, streaming: false, ...patch };
}

function step(
  cursor: AutoReadCursor | null,
  runId: string | null,
  settled: boolean,
  messages: readonly Message[],
  threadKey = "t1",
  {
    completed = true,
    live = true,
    now = 0,
    catchUpMs = 0,
  }: { completed?: boolean; live?: boolean; now?: number; catchUpMs?: number } = {},
) {
  return nextAutoRead(cursor, {
    threadKey,
    runId,
    settled,
    completed,
    live,
    now,
    catchUpMs,
    messages,
  });
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

  it("passes over a run that settled while the snapshot was not live", () => {
    // Cached at r1 while it ran; catching up delivers r2 already settled.
    const cached = step(null, "r1", false, [], "t1", { live: false });
    const synced = step(cached.cursor, "r2", true, [reply("b", "r2")], "t1", { live: false });
    const live = step(synced.cursor, "r2", true, [reply("b", "r2")]);
    expect(live.reply).toBeNull();
    const nextRun = step(live.cursor, "r3", false, [reply("b", "r2")]);
    expect(step(nextRun.cursor, "r3", true, [reply("c", "r3")]).reply?.id).toBe("c");
  });

  it("starts over when a live thread stops being live mid-run", () => {
    const running = step(null, "r2", false, [reply("a", "r1")]);
    const away = step(running.cursor, "r2", false, [reply("a", "r1")], "t1", { live: false });
    const back = step(away.cursor, "r2", true, [reply("b", "r2")]);
    expect(back.reply).toBeNull();
  });

  it("passes over a run under way on resuming that settles while buffered events catch up", () => {
    const resume = { catchUpMs: 5_000 };
    const running = step(null, "r2", false, [], "t1", resume);
    const away = step(running.cursor, "r2", false, [], "t1", { ...resume, live: false });
    // Back in the foreground with the stale snapshot, then the buffered completion is applied.
    const back = step(away.cursor, "r2", false, [], "t1", { ...resume, now: 60_000 });
    const buffered = step(back.cursor, "r2", true, [reply("b", "r2")], "t1", {
      ...resume,
      now: 60_500,
    });
    expect(buffered.reply).toBeNull();
    const nextRun = step(buffered.cursor, "r3", false, [], "t1", { ...resume, now: 61_000 });
    const done = step(nextRun.cursor, "r3", true, [reply("c", "r3")], "t1", {
      ...resume,
      now: 62_000,
    });
    expect(done.reply?.id).toBe("c");
  });

  it("reads a run once catching up is over, and a new run however soon it settles", () => {
    const resume = { catchUpMs: 5_000 };
    const back = step(null, "r2", false, [], "t1", resume);
    const late = step(back.cursor, "r2", true, [reply("b", "r2")], "t1", { ...resume, now: 5_000 });
    expect(late.reply?.id).toBe("b");
    // A new thread: its first run starts and settles within the window, yet was seen running.
    const empty = step(null, null, false, [], "t2", resume);
    const started = step(empty.cursor, "x1", false, [], "t2", { ...resume, now: 500 });
    const quick = step(started.cursor, "x1", true, [reply("y", "x1")], "t2", {
      ...resume,
      now: 1_500,
    });
    expect(quick.reply?.id).toBe("y");
  });

  it("passes over a stopped run without reading its partial reply", () => {
    const running = step(null, "r2", false, [reply("a", "r1")]);
    const stopped = step(running.cursor, "r2", true, [reply("b", "r2")], "t1", {
      completed: false,
    });
    expect(stopped.reply).toBeNull();
    expect(step(stopped.cursor, "r2", true, [reply("b", "r2")]).reply).toBeNull();
  });
});
