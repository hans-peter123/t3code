import { describe, expect, it } from "vite-plus/test";

import {
  decideSpeak,
  requestedReadMode,
  resolveSpokenText,
  type SpeakDecision,
} from "./readMode.ts";

const failing = () => Promise.reject(new Error("provider unavailable"));

describe("resolveSpokenText", () => {
  it("reads the full reply without asking for a summary in full mode", async () => {
    let asked = false;
    const result = await resolveSpokenText({
      mode: "full",
      fullText: "Full reply",
      loadSummary: async () => {
        asked = true;
        return "Short";
      },
    });
    expect(result).toEqual({ mode: "full", text: "Full reply" });
    expect(asked).toBe(false);
  });

  it("reads the full reply without a notice when there is no server thread", async () => {
    expect(await resolveSpokenText({ mode: "short", fullText: "Full", loadSummary: null })).toEqual(
      { mode: "full", text: "Full" },
    );
  });

  it("reads the summary in short mode", async () => {
    expect(
      await resolveSpokenText({
        mode: "short",
        fullText: "Full",
        loadSummary: async () => " Short ",
      }),
    ).toEqual({ mode: "short", text: "Short" });
  });

  it("falls back to the full reply with a notice when the summary fails or is empty", async () => {
    const failed = await resolveSpokenText({
      mode: "short",
      fullText: "Full",
      loadSummary: failing,
    });
    expect(failed.mode).toBe("full");
    expect(failed.text).toBe("Full");
    expect(failed.shortUnavailable).toBeInstanceOf(Error);

    const empty = await resolveSpokenText({
      mode: "short",
      fullText: "Full",
      loadSummary: async () => "  ",
    });
    expect(empty.mode).toBe("full");
    expect(empty.shortUnavailable).toBeInstanceOf(Error);
  });
});

describe("decideSpeak", () => {
  const base = {
    loaded: true,
    preparing: false,
    switchingToShort: false,
    currentMode: "full",
    requestedMode: "full",
  } as const;

  it.each<[string, Partial<Parameters<typeof decideSpeak>[0]>, SpeakDecision]>([
    ["starts a message that is not loaded", { loaded: false }, "start"],
    ["toggles pause for the same mode", {}, "togglePause"],
    ["switches to Short while the full reply plays", { requestedMode: "short" }, "switchToShort"],
    ["restarts in Full while Short plays", { currentMode: "short" }, "start"],
    [
      "restarts a message still preparing in the other mode",
      { preparing: true, requestedMode: "short" },
      "start",
    ],
    [
      "cancels a switch to Short when Full is asked",
      { switchingToShort: true, requestedMode: "full" },
      "cancelShortSwitch",
    ],
    [
      "ignores Short again while it is written",
      { switchingToShort: true, requestedMode: "short" },
      "ignore",
    ],
  ])("%s", (_name, patch, expected) => {
    expect(decideSpeak({ ...base, ...patch })).toBe(expected);
  });

  it("plays Full when the reply has no summary source", () => {
    expect(requestedReadMode("short", false)).toBe("full");
    expect(requestedReadMode(undefined, true)).toBe("full");
    expect(requestedReadMode("short", true)).toBe("short");
  });
});
