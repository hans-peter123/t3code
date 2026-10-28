import { useNavigate } from "@tanstack/react-router";
import { parseScopedThreadKey } from "@t3tools/client-runtime/environment";
import { useEffect, useRef } from "react";

import type { ChatMessage } from "../types";
import { type AutoReadCursor, nextAutoRead } from "./autoRead";
import { readMessageAloud, replySpeechRequest } from "./ReadAloudButton";
import { currentSpeechPhase } from "./speechPlayback";
import { useSpeechSettings } from "./speechSettings";
import { useCanSummarize } from "./spokenSummary";

/** Reads each finished reply in the open thread aloud while "Read new replies" is on. */
export function useAutoReadReplies(input: {
  readonly threadKey: string;
  readonly runId: string | null;
  readonly settled: boolean;
  readonly messages: readonly ChatMessage[];
  readonly title: string;
  /** Drafts have no server thread to summarize, so their replies are read in full. */
  readonly serverThread: boolean;
}) {
  const navigate = useNavigate();
  const enabled = useSpeechSettings().autoRead;
  const cursor = useRef<AutoReadCursor | null>(null);
  const { threadKey, runId, settled, messages, title, serverThread } = input;
  const canSummarize = useCanSummarize(parseScopedThreadKey(threadKey)?.environmentId ?? null);
  const summarizable = serverThread && canSummarize;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- starts audio playback when a run in the open thread finishes.
  useEffect(() => {
    const next = nextAutoRead(cursor.current, { threadKey, runId, settled, messages });
    cursor.current = next.cursor;
    // A reply that arrives while another plays is skipped rather than cutting it off.
    if (!next.reply || !enabled) return;
    const phase = currentSpeechPhase();
    if (phase === "playing" || phase === "preparing") return;
    readMessageAloud(
      replySpeechRequest({
        messageId: next.reply.id,
        markdown: next.reply.text,
        title,
        threadRef: summarizable ? parseScopedThreadKey(threadKey) : null,
      }),
      (to) => void navigate({ to }),
    );
  }, [threadKey, runId, settled, messages, title, summarizable, enabled, navigate]);
}
