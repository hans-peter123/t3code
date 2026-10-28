import * as Schema from "effect/Schema";

import { MessageId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const SpokenSummaryInput = Schema.Struct({
  threadId: ThreadId,
  /** An assistant message of the run to speak about; the latest finished reply when absent. */
  messageId: Schema.optional(MessageId),
  /** BCP 47 tag, used only when the thread's own language is unclear. */
  languageHint: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(35))),
});
export type SpokenSummaryInput = typeof SpokenSummaryInput.Type;

export const SpokenSummaryResult = Schema.Struct({
  text: Schema.String,
});
export type SpokenSummaryResult = typeof SpokenSummaryResult.Type;

/** Clients read the full reply instead when this fails. */
export class SpokenSummaryError extends Schema.TaggedError<SpokenSummaryError>()(
  "SpokenSummaryError",
  {
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Could not write the spoken summary: ${this.detail}`;
  }
}
