import { describe, expect, it } from "@effect/vitest";
import { MessageId, ProviderInstanceId, RunId, SpokenSummaryError } from "@t3tools/contracts";
import * as Cache from "effect/Cache";
import * as Effect from "effect/Effect";

import {
  makeSpokenSummaryCache,
  SpokenSummaryKey,
  type SpokenSummaryRequest,
} from "./SpokenSummaryService.ts";

type Context = SpokenSummaryRequest["context"];
const request = (
  model: string,
  changedFiles: Context["changedFiles"] = [],
  latestRunOutcome: Context["latestRunOutcome"] = { status: "completed", error: null },
): SpokenSummaryRequest => ({
  context: {
    threadTitle: "Panel",
    originalTask: "Restyle the panel",
    history: [],
    omittedHistory: 0,
    latestRequest: null,
    latestReply: ["Done."],
    latestRunOutcome,
    changedFiles,
    omittedChangedFiles: 0,
    pending: [],
  },
  modelSelection: { instanceId: ProviderInstanceId.make("claudeAgent"), model },
});
const key = (
  input: {
    readonly model?: string;
    readonly updatedAt?: number;
    readonly changedFiles?: Context["changedFiles"];
    readonly latestRunOutcome?: Context["latestRunOutcome"];
  } = {},
) =>
  new SpokenSummaryKey(
    "thread:1",
    {
      runId: RunId.make("run:1"),
      messageId: MessageId.make("a1"),
      updatedAt: input.updatedAt ?? 1,
    },
    request(input.model ?? "claude-opus-5-5", input.changedFiles, input.latestRunOutcome),
  );

describe("spoken summary cache", () => {
  it.effect("writes a reply once per model, reply version, changed files and run outcome", () =>
    Effect.gen(function* () {
      const written: Array<string> = [];
      const cache = yield* makeSpokenSummaryCache((input) =>
        Effect.sync(() => {
          written.push(input.modelSelection.model);
          return { text: `summary ${written.length}` };
        }),
      );
      expect(yield* Cache.get(cache, key())).toEqual({ text: "summary 1" });
      expect(yield* Cache.get(cache, key())).toEqual({ text: "summary 1" });
      expect(yield* Cache.get(cache, key({ model: "claude-sonnet-5" }))).toEqual({
        text: "summary 2",
      });
      expect(yield* Cache.get(cache, key({ updatedAt: 2 }))).toEqual({ text: "summary 3" });
      const captured = [{ path: "src/panel.css", additions: 3, deletions: 1 }];
      expect(yield* Cache.get(cache, key({ changedFiles: captured }))).toEqual({
        text: "summary 4",
      });
      const interrupted = { status: "interrupted", error: null } as const;
      expect(yield* Cache.get(cache, key({ latestRunOutcome: interrupted }))).toEqual({
        text: "summary 5",
      });
      expect(written).toHaveLength(5);
    }),
  );

  it.effect("retries after a failure or an empty summary instead of keeping it", () =>
    Effect.gen(function* () {
      let attempts = 0;
      const cache = yield* makeSpokenSummaryCache(() =>
        Effect.suspend(() => {
          attempts++;
          if (attempts === 1) {
            return Effect.fail(new SpokenSummaryError({ detail: "Claude is not installed." }));
          }
          return Effect.succeed({ text: attempts === 2 ? "  \n" : "summary" });
        }),
      );
      expect((yield* Cache.get(cache, key()).pipe(Effect.flip)).detail).toBe(
        "Claude is not installed.",
      );
      expect((yield* Cache.get(cache, key()).pipe(Effect.flip)).detail).toBe(
        "The model returned an empty summary.",
      );
      expect(yield* Cache.get(cache, key())).toEqual({ text: "summary" });
      expect(attempts).toBe(3);
    }),
  );

  it.effect("forgets the oldest summary past its capacity", () =>
    Effect.gen(function* () {
      let writes = 0;
      const cache = yield* makeSpokenSummaryCache(
        () => Effect.sync(() => ({ text: `summary ${++writes}` })),
        2,
      );
      yield* Cache.get(cache, key({ updatedAt: 1 }));
      yield* Cache.get(cache, key({ updatedAt: 2 }));
      yield* Cache.get(cache, key({ updatedAt: 3 }));
      yield* Cache.get(cache, key({ updatedAt: 1 }));
      expect(writes).toBe(4);
    }),
  );
});
