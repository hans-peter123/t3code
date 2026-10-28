#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeUtil from "node:util";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ClaudeSettings,
  DEFAULT_SPOKEN_SUMMARY_MODEL,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as ClaudeTextGeneration from "../../apps/server/src/textGeneration/ClaudeTextGeneration.ts";
import { spokenSummaryEvaluationCases } from "./cases.ts";

const { values } = NodeUtil.parseArgs({
  options: {
    model: { type: "string", default: DEFAULT_SPOKEN_SUMMARY_MODEL },
    out: { type: "string" },
    baseline: { type: "string" },
    case: { type: "string", multiple: true },
    samples: { type: "string", default: "2" },
  },
});
if (!values.out) throw new Error("Use --out <directory> [--model <claude model>].");
const outputDirectory = values.out;
const samples = Math.max(1, Number(values.samples));
const selected = values.case
  ? spokenSummaryEvaluationCases.filter((entry) => values.case!.includes(entry.id))
  : spokenSummaryEvaluationCases;
const Results = Schema.fromJsonString(
  Schema.Array(Schema.Struct({ id: Schema.String, sample: Schema.Number, text: Schema.String })),
);
const decodeResults = Schema.decodeUnknownEffect(Results);
const decodeSettings = Schema.decodeUnknownEffect(ClaudeSettings);
const encodeReport = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

await Effect.runPromise(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-spoken-summary-evaluation-" });
    const generation = yield* ClaudeTextGeneration.makeClaudeTextGeneration(
      yield* decodeSettings({}),
    );
    const baseline = values.baseline
      ? yield* fs.readFileString(values.baseline).pipe(Effect.flatMap(decodeResults))
      : [];
    const results = [];
    const review = [];
    const answerKey = [];
    for (const fixture of selected) {
      for (let sample = 0; sample < samples; sample++) {
        const [elapsed, generated] = yield* generation
          .generateSpokenSummary({
            cwd,
            context: fixture.context,
            modelSelection: {
              instanceId: ProviderInstanceId.make("claudeAgent"),
              model: values.model,
            },
          })
          .pipe(Effect.timed);
        results.push({
          id: fixture.id,
          sample,
          text: generated.text,
          words: generated.text.split(/\s+/).length,
          latencyMs: Duration.toMillis(elapsed),
        });
        const previous = baseline.find(
          (entry) => entry.id === fixture.id && entry.sample === sample,
        );
        const newFirst = NodeCrypto.randomInt(2) === 0;
        review.push({
          id: fixture.id,
          sample,
          source: fixture.source,
          rubric: fixture.rubric,
          A: previous === undefined || newFirst ? generated.text : previous.text,
          B: previous === undefined ? "" : newFirst ? previous.text : generated.text,
          meetsRubric: "",
          preferred: "",
        });
        answerKey.push({ id: fixture.id, sample, candidate: newFirst ? "A" : "B" });
      }
    }
    yield* fs.makeDirectory(outputDirectory, { recursive: true });
    for (const [name, report] of [
      ["results", results],
      ["review", review],
      ["answer-key", answerKey],
    ] as const) {
      yield* fs.writeFileString(
        path.join(outputDirectory, `${name}.json`),
        yield* encodeReport(report),
      );
    }
    yield* Effect.log(
      `Wrote ${results.length} summaries to ${outputDirectory}. Score review.json before opening answer-key.json.`,
    );
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);
