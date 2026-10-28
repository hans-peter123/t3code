import { describe, expect, it } from "vite-plus/test";

import { resolveSpokenText } from "./readMode.ts";

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
