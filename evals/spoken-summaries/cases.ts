import type { SpokenSummaryContext } from "@t3tools/provider-core/server/textGeneration";

const base = {
  history: [],
  omittedHistory: 0,
  latestRequest: null,
  changedFiles: [],
  omittedChangedFiles: 0,
  pending: [],
  latestRunOutcome: { status: "completed", error: null },
} satisfies Partial<SpokenSummaryContext>;

const SOURCE = "Spoken summary product decisions with the maintainer, October 2026";

export const spokenSummaryEvaluationCases: ReadonlyArray<{
  readonly id: string;
  readonly source: string;
  readonly context: SpokenSummaryContext;
  readonly rubric: string;
}> = [
  {
    id: "decision-and-open-question",
    source: SOURCE,
    context: {
      ...base,
      threadTitle: "Responsive thread panel",
      originalTask: "Restyle the thread panel so it reads better on narrow windows.",
      history: [
        {
          role: "assistant",
          text: "I tightened spacing and swapped the accent colors for the new palette.",
        },
        { role: "user", text: "Keep the old accent colors, people know them." },
        {
          role: "assistant",
          text: "I kept the accent colors and only changed spacing and type sizes in the panel.",
        },
      ],
      latestRequest: "Now make it responsive.",
      latestReply: [
        "I switched the panel from a fixed 420px width to a fluid layout with a 320px minimum. Below 640px it collapses into a bottom sheet instead of overlapping the chat.\n\n```css\n.panel { width: clamp(320px, 30vw, 520px); }\n@media (max-width: 640px) { .panel { position: fixed; inset: auto 0 0 0; } }\n```\n\nI did not use a container query because Safari 16 still ships in our support matrix.\n\nShould the bottom sheet breakpoint stay at 640px, or match the 768px tablet breakpoint the composer uses?",
      ],
      changedFiles: [
        { path: "apps/web/src/components/thread/panel.css", additions: 38, deletions: 12 },
        { path: "apps/web/src/components/thread/ThreadPanel.tsx", additions: 9, deletions: 3 },
      ],
      pending: ["Approval needed: Run the visual regression tests"],
    },
    rubric:
      "Says the panel is now fluid and becomes a bottom sheet on small screens. Treats the old accent colors as kept, not the new palette the user overruled. Explains why no container query (older Safari). Asks the breakpoint question with both choices, and mentions the approval waiting for the visual tests. No CSS, pixel lists or file paths read aloud.",
  },
  {
    id: "german-thread",
    source: SOURCE,
    context: {
      ...base,
      threadTitle: "Login-Test stabilisieren",
      originalTask: "Der Login-Test schlägt auf CI ab und zu fehl. Finde heraus warum.",
      latestRequest: "Bau bitte einen Fix, aber ohne Retry.",
      history: [
        {
          role: "assistant",
          text: "Der Test wartet nicht auf das Session-Cookie, bevor er die Startseite lädt. Auf langsamen CI-Maschinen kommt das Cookie zu spät.",
        },
      ],
      latestReply: [
        "Der Test wartet jetzt auf die Antwort von `POST /api/session`, bevor er navigiert. Ich habe keinen Retry eingebaut. 50 Läufe hintereinander waren grün.",
      ],
      changedFiles: [{ path: "apps/web/test/login.browser.test.ts", additions: 6, deletions: 2 }],
    },
    rubric:
      "Entirely in German. Says the test now waits for the session before navigating, that there is no retry as asked, and that repeated runs passed. Nothing for the user to do beyond reviewing. No endpoint path read aloud.",
  },
  {
    id: "code-heavy-reply",
    source: SOURCE,
    context: {
      ...base,
      threadTitle: "Crash on empty settings file",
      originalTask: "The server crashes on startup when settings.json is empty. Fix it.",
      latestReply: [
        'Found it. The decoder threw on an empty string:\n\n```\nSyntaxError: Unexpected end of JSON input\n    at JSON.parse (<anonymous>)\n    at readSettings (apps/server/src/serverSettings.ts:212:18)\n```\n\nFix:\n\n```ts\nconst raw = yield* fs.readFileString(path);\nif (raw.trim() === "") return DEFAULT_SERVER_SETTINGS;\n```\n\nAdded a test in `serverSettings.test.ts` that writes an empty file and expects defaults. `vp test run src/serverSettings.test.ts` passes.',
      ],
      changedFiles: [
        { path: "apps/server/src/serverSettings.ts", additions: 2, deletions: 0 },
        { path: "apps/server/src/serverSettings.test.ts", additions: 14, deletions: 0 },
      ],
    },
    rubric:
      "Explains in words that an empty settings file now falls back to defaults instead of crashing, and that a test covers it and passes. Reads no code, stack trace, command or file path.",
  },
  {
    id: "interrupted-run",
    source: SOURCE,
    context: {
      ...base,
      threadTitle: "Settings migration",
      originalTask: "Rename the theme setting to appearance and migrate existing settings files.",
      latestReply: [
        "I renamed the setting in the schema and the settings panel. Now I will update the migration and run the settings tests.",
      ],
      latestRunOutcome: { status: "interrupted", error: null },
      changedFiles: [{ path: "packages/contracts/src/settings.ts", additions: 4, deletions: 4 }],
    },
    rubric:
      "Says the run was stopped before it finished: the setting is renamed, but the migration was not updated and the tests did not run. Does not say the agent is updating the migration or running tests now. Suggests continuing the run when the user wants the migration.",
  },
  {
    id: "small-reply-control",
    source: SOURCE,
    context: {
      ...base,
      threadTitle: "Cache size",
      originalTask: "How many entries does the favicon cache keep?",
      latestReply: ["It keeps 500 entries and evicts the oldest first. Nothing changed."],
    },
    rubric:
      "Two or three short sentences: 500 entries, oldest evicted first, nothing changed. No padding, no greeting, no offer to help.",
  },
];
