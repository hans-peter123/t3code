# Spoken summaries

Writes the short spoken version of a reply for prepared thread contexts with the server's Claude text generator, then sets each new summary against a baseline for a blind review. It tests the prompt in `packages/provider-core/src/server/textGenerationPrompts.ts`; the context selection has unit tests on the server.

## Run

```sh
cd evals
pnpm spoken-summaries --out runs/spoken
pnpm spoken-summaries --out runs/spoken-new --baseline runs/spoken/results.json
```

- It uses your local Claude Code login, like the server does. `--model` defaults to the server's default spoken summary model.
- `--case <id>` runs one case, `--samples <n>` sets the samples per case (default 2).
- A run writes `results.json` (summaries, word counts, latency), `review.json` (A and B in random order, with a rubric), and `answer-key.json`. Score `review.json` against each rubric before you open `answer-key.json`. A case fails when half or more of its samples miss the rubric.

## Add a case

Add an entry to `cases.ts` with an `id`, a `source`, the prepared `context`, and a `rubric` that says what a listener must hear and what must not be read aloud.

## Cost

One case is one call to the chosen Claude model with a few thousand tokens of thread. A full run at two samples is eight calls.
