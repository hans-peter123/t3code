import {
  SpokenSummaryError,
  type SpokenSummaryInput,
  type SpokenSummaryResult,
  type TextGenerationError,
} from "@t3tools/contracts";
import type { SpokenSummaryGenerationInput } from "@t3tools/provider-core/server/textGeneration";
import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Hash from "effect/Hash";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import { buildSpokenSummaryContext, type SpokenSummaryTarget } from "./SpokenSummaryContext.ts";

const CACHE_CAPACITY = 64;

export class SpokenSummaryService extends Context.Service<
  SpokenSummaryService,
  {
    readonly generate: (
      input: SpokenSummaryInput,
    ) => Effect.Effect<SpokenSummaryResult, SpokenSummaryError>;
  }
>()("t3/spokenSummary/SpokenSummaryService") {}

/** Every generation runs in the same neutral folder, so it is not part of the cached request. */
export type SpokenSummaryRequest = Omit<SpokenSummaryGenerationInput, "cwd">;

/** Equal by identity only, so the cache never hashes the thread text it carries. */
export class SpokenSummaryKey implements Equal.Equal {
  readonly id: string;
  readonly request: SpokenSummaryRequest;
  constructor(threadId: string, target: SpokenSummaryTarget, request: SpokenSummaryRequest) {
    this.request = request;
    this.id = JSON.stringify([
      threadId,
      target.runId,
      target.messageId,
      target.updatedAt,
      request.context.pending,
      // A run can be stopped or fail after its last message without changing that message.
      request.context.latestRunOutcome,
      // Checkpoints land after the run ends, so a summary asked for right away has no files yet.
      request.context.changedFiles,
      request.context.omittedChangedFiles,
      request.modelSelection,
      request.languageHint ?? null,
    ]);
  }
  [Equal.symbol](that: unknown): boolean {
    return that instanceof SpokenSummaryKey && that.id === this.id;
  }
  [Hash.symbol](): number {
    return Hash.string(this.id);
  }
}

/**
 * Keeps successful summaries only, so a failed or unavailable provider is retried next time.
 * An empty summary counts as a failure: clients then read the full reply instead of silence.
 */
export const makeSpokenSummaryCache = <E, R>(
  generate: (request: SpokenSummaryRequest) => Effect.Effect<SpokenSummaryResult, E, R>,
  capacity = CACHE_CAPACITY,
) =>
  Cache.makeWith(
    (key: SpokenSummaryKey) =>
      generate(key.request).pipe(
        Effect.filterOrFail(
          (result) => result.text.trim().length > 0,
          () => new SpokenSummaryError({ detail: "The model returned an empty summary." }),
        ),
      ),
    {
      capacity,
      timeToLive: (exit) => (Exit.isSuccess(exit) ? Duration.infinity : Duration.zero),
    },
  );

const generationFailed = (cause: TextGenerationError) =>
  new SpokenSummaryError({ detail: cause.detail, cause });

const make = Effect.gen(function* () {
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const fileSystem = yield* FileSystem.FileSystem;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const textGeneration = yield* TextGeneration.TextGeneration;
  const { stateDir } = yield* ServerConfig.ServerConfig;
  const path = yield* Path.Path;
  // The summary uses no tools, so it runs outside the checkout: project instruction files
  // (CLAUDE.md, AGENTS.md) would add cost and could override the spoken style or language.
  // One fixed folder, because OpenCode keeps an instance per directory on a shared server.
  const cwd = path.join(stateDir, "spoken-summary");
  const cache = yield* makeSpokenSummaryCache((request) =>
    fileSystem.makeDirectory(cwd, { recursive: true }).pipe(
      Effect.mapError(
        (cause) => new SpokenSummaryError({ detail: "Could not prepare a working folder.", cause }),
      ),
      Effect.andThen(
        textGeneration
          .generateSpokenSummary({ ...request, cwd })
          .pipe(Effect.mapError(generationFailed)),
      ),
    ),
  );

  const readContext = Effect.fn("SpokenSummaryService.readContext")(function* (
    input: SpokenSummaryInput,
  ) {
    const records = yield* threads.getThreadRecords(
      input.threadId,
      ["messages", "runs", "checkpoints", "runtimeRequests", "turnItems"],
      {
        messageRoles: ["user", "assistant"],
        turnItemTypes: ["approval_request", "user_input_request", "error"],
      },
    );
    const selected = buildSpokenSummaryContext(records, input.messageId);
    if (selected === null) {
      return yield* new SpokenSummaryError({ detail: "This thread has no reply to read." });
    }
    return selected;
  });

  const generate: SpokenSummaryService["Service"]["generate"] = Effect.fn(
    "SpokenSummaryService.generate",
  )(
    function* (input) {
      const { context, target } = yield* readContext(input);
      const { spokenSummaryModelSelection: modelSelection } = yield* serverSettings.getSettings;
      const key = new SpokenSummaryKey(input.threadId, target, {
        context,
        languageHint: input.languageHint,
        modelSelection,
      });
      return yield* Cache.get(cache, key);
    },
    Effect.mapError((error) =>
      error._tag === "SpokenSummaryError"
        ? error
        : new SpokenSummaryError({ detail: "Could not read the thread.", cause: error }),
    ),
  );

  return SpokenSummaryService.of({ generate });
});

export const layer = Layer.effect(SpokenSummaryService, make);
