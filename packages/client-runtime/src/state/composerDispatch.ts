export type ComposerDispatchMode = "auto" | "queue" | "steer" | "restart";
export type ActiveTurnComposerAction = Exclude<ComposerDispatchMode, "auto">;

export function resolveComposerDispatchMode(input: {
  readonly running: boolean;
  readonly alternateModifier: boolean;
  readonly activeTurnDefault?: ActiveTurnComposerAction;
  /** False while the active turn cannot take steering input, such as during compaction. */
  readonly canSteer?: boolean;
}): ComposerDispatchMode {
  if (!input.running) return "auto";
  if (input.canSteer === false) return "queue";
  const defaultAction = input.activeTurnDefault ?? "steer";
  if (input.alternateModifier) return defaultAction === "queue" ? "steer" : "queue";
  return defaultAction;
}

export function alternateComposerDispatchAction(
  activeTurnDefault?: ActiveTurnComposerAction,
): ActiveTurnComposerAction {
  return resolveComposerDispatchMode({
    running: true,
    alternateModifier: true,
    ...(activeTurnDefault === undefined ? {} : { activeTurnDefault }),
  }) as ActiveTurnComposerAction;
}

/**
 * How a follow-up reaches the thread, as the composer sends it: queued while a run is still being
 * set up, else the resolved action while a turn runs (steering travels as "auto", so an ended turn
 * queues a run instead), and null to start a turn when nothing runs.
 */
export function resolveFollowUpDispatchMode(input: {
  readonly running: boolean;
  readonly setupRunning: boolean;
  readonly canSteer: boolean;
  readonly activeTurnDefault: ActiveTurnComposerAction;
  readonly alternateModifier?: boolean;
}): "queue" | "auto" | null {
  if (input.setupRunning) return "queue";
  const action = resolveComposerDispatchMode({
    running: input.running && input.canSteer,
    alternateModifier: input.alternateModifier ?? false,
    activeTurnDefault: input.activeTurnDefault,
  });
  if (action === "auto") return null;
  return action === "queue" ? "queue" : "auto";
}
