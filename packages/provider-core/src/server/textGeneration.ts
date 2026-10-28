import type {
  BranchNamingOptions,
  ChatAttachment,
  ModelSelection,
  PullRequestReviewGuide,
  TextGenerationError,
} from "@t3tools/contracts";
import type * as Effect from "effect/Effect";

import type { TextGenerationPolicy } from "./textGenerationPolicy.ts";
import type { ThreadTitleForkSource } from "./textGenerationPrompts.ts";

export interface CommitMessageGenerationInput {
  cwd: string;
  branch: string | null;
  stagedSummary: string;
  stagedPatch: string;
  includeBranch?: boolean;
  policy?: TextGenerationPolicy | undefined;
  modelSelection: ModelSelection;
}

export interface CommitMessageGenerationResult {
  subject: string;
  body: string;
  branch?: string | undefined;
}

export interface PrContentGenerationInput {
  cwd: string;
  baseBranch: string;
  headBranch: string;
  commitSummary: string;
  diffSummary: string;
  diffPatch: string;
  changeRequestTemplate?: string | undefined;
  threadContext?: string | undefined;
  policy?: TextGenerationPolicy | undefined;
  modelSelection: ModelSelection;
}

export interface PrContentGenerationResult {
  title: string;
  body: string;
}

export interface BranchNameGenerationInput {
  naming?: BranchNamingOptions | undefined;
  cwd: string;
  message: string;
  attachments?: ReadonlyArray<ChatAttachment> | undefined;
  modelSelection: ModelSelection;
}

export interface BranchNameGenerationResult {
  branch: string;
}

export interface ThreadTitleGenerationInput {
  linkedContext?: string | undefined;
  cwd: string;
  message: string;
  previousTitle?: string | undefined;
  forkSource?: ThreadTitleForkSource | undefined;
  attachments?: ReadonlyArray<ChatAttachment> | undefined;
  instructions?: string | undefined;
  modelSelection: ModelSelection;
}

export interface ThreadTitleGenerationResult {
  title: string;
  needsRefinement?: boolean | undefined;
}

export interface ReviewGuideStackLayer {
  readonly number: number;
  readonly title: string | null;
  readonly headSha: string | null;
  readonly state: "open" | "closed" | "merged";
}

export interface ReviewGuideGenerationInput {
  cwd: string;
  number: number;
  title: string;
  description: string;
  baseBranch: string;
  baseCommit: string;
  settledReview: string;
  instructions?: string | undefined;
  stack?: ReadonlyArray<ReviewGuideStackLayer> | undefined;
  modelSelection: ModelSelection;
}

export type ReviewGuideGenerationResult = Omit<
  PullRequestReviewGuide,
  "headSha" | "generatedAt" | "modelSelection"
>;

export interface SpokenSummaryChangedFile {
  readonly path: string;
  readonly additions?: number | undefined;
  readonly deletions?: number | undefined;
}

export interface SpokenSummaryHistoryEntry {
  readonly role: "user" | "assistant";
  readonly text: string;
}

/** How the run being spoken about stands; queued and starting runs count as running. */
export interface SpokenSummaryRunOutcome {
  readonly status: "running" | "waiting" | "completed" | "interrupted" | "failed" | "cancelled";
  /** The provider's last error when the run failed. */
  readonly error: string | null;
}

/** Thread material for a spoken summary, already selected and trimmed to a budget. */
export interface SpokenSummaryContext {
  readonly threadTitle: string;
  readonly originalTask: string;
  /** Earlier runs in order: later user messages, answered questions and each run's final reply. */
  readonly history: ReadonlyArray<SpokenSummaryHistoryEntry>;
  readonly omittedHistory: number;
  /** The user message that started the run being spoken about, when it is not the original task. */
  readonly latestRequest: string | null;
  /** Every assistant message of the run being spoken about, in order. */
  readonly latestReply: ReadonlyArray<string>;
  /** Null for imported history, which has no runs. */
  readonly latestRunOutcome: SpokenSummaryRunOutcome | null;
  readonly changedFiles: ReadonlyArray<SpokenSummaryChangedFile>;
  readonly omittedChangedFiles: number;
  /** Open approvals and questions that wait for the user. */
  readonly pending: ReadonlyArray<string>;
}

export interface SpokenSummaryGenerationInput {
  cwd: string;
  context: SpokenSummaryContext;
  /** BCP 47 tag used only when the thread's own language is unclear. */
  languageHint?: string | undefined;
  modelSelection: ModelSelection;
}

export interface SpokenSummaryGenerationResult {
  text: string;
}

export interface ProviderTextGeneration {
  readonly generateCommitMessage: (
    input: CommitMessageGenerationInput,
  ) => Effect.Effect<CommitMessageGenerationResult, TextGenerationError>;

  readonly generatePrContent: (
    input: PrContentGenerationInput,
  ) => Effect.Effect<PrContentGenerationResult, TextGenerationError>;

  readonly generateBranchName: (
    input: BranchNameGenerationInput,
  ) => Effect.Effect<BranchNameGenerationResult, TextGenerationError>;

  readonly generateThreadTitle: (
    input: ThreadTitleGenerationInput,
  ) => Effect.Effect<ThreadTitleGenerationResult, TextGenerationError>;

  readonly generateReviewGuide: (
    input: ReviewGuideGenerationInput,
  ) => Effect.Effect<ReviewGuideGenerationResult, TextGenerationError>;

  readonly generateSpokenSummary: (
    input: SpokenSummaryGenerationInput,
  ) => Effect.Effect<SpokenSummaryGenerationResult, TextGenerationError>;
}
