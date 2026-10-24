import {
  transcribeAudio,
  transcriptionProvider,
  transcriptionProviderProblem,
} from "@t3tools/client-runtime/speech";
import { LoaderIcon, MicIcon, SquareIcon, XIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Button } from "../components/ui/button";
import { toastManager } from "../components/ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import { useSpeechSettings } from "./speechSettings";

const RECORDING_LIMIT_SECONDS = 5 * 60;

type Phase = "idle" | "recording" | "transcribing";

interface Recording {
  readonly recorder: MediaRecorder;
  readonly stream: MediaStream;
  readonly chunks: Blob[];
  readonly startedAt: number;
  cancelled: boolean;
}

function fileNameFor(mimeType: string): string {
  if (mimeType.includes("mp4")) return "recording.m4a";
  if (mimeType.includes("ogg")) return "recording.ogg";
  return "recording.webm";
}

/**
 * Records from the microphone and inserts the transcript at the cursor. Shown only when a
 * dictation provider is set in Settings > Voice; the browser has no on-device fallback.
 */
export function DictationButton(props: {
  readonly disabled?: boolean;
  readonly onTranscript: (text: string) => void;
}) {
  const settings = useSpeechSettings();
  const provider = transcriptionProvider(settings);
  const ready = provider !== null && transcriptionProviderProblem(provider) === null;
  const [phase, setPhase] = useState<Phase>("idle");
  const [elapsed, setElapsed] = useState(0);
  const recordingRef = useRef<Recording | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const onTranscriptRef = useRef(props.onTranscript);
  onTranscriptRef.current = props.onTranscript;

  const release = (recording: Recording) => {
    for (const track of recording.stream.getTracks()) track.stop();
  };

  useEffect(
    () => () => {
      abortRef.current?.abort();
      const recording = recordingRef.current;
      if (recording) {
        recording.cancelled = true;
        if (recording.recorder.state !== "inactive") recording.recorder.stop();
        release(recording);
      }
    },
    [],
  );

  useEffect(() => {
    if (phase !== "recording") return;
    const interval = setInterval(() => {
      const recording = recordingRef.current;
      if (!recording) return;
      const seconds = Math.floor((Date.now() - recording.startedAt) / 1000);
      setElapsed(seconds);
      if (seconds >= RECORDING_LIMIT_SECONDS) stop();
    }, 250);
    return () => clearInterval(interval);
  });

  if (!ready) return null;

  const fail = (title: string, error: unknown) => {
    toastManager.add({
      type: "error",
      title,
      description: error instanceof Error ? error.message : "Try again.",
    });
  };

  const transcribe = async (blob: Blob, mimeType: string) => {
    const controller = new AbortController();
    abortRef.current = controller;
    setPhase("transcribing");
    try {
      const text = await transcribeAudio(provider, blob, fileNameFor(mimeType), controller.signal);
      if (text) onTranscriptRef.current(text);
    } catch (error) {
      if (!controller.signal.aborted) fail("Dictation failed", error);
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      setPhase("idle");
    }
  };

  const start = async () => {
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (error) {
      fail("Microphone unavailable", error);
      return;
    }
    const recorder = new MediaRecorder(stream);
    const recording: Recording = {
      recorder,
      stream,
      chunks: [],
      startedAt: Date.now(),
      cancelled: false,
    };
    recorder.addEventListener("dataavailable", (event) => {
      if (event.data.size > 0) recording.chunks.push(event.data);
    });
    recorder.addEventListener("stop", () => {
      release(recording);
      if (recordingRef.current === recording) recordingRef.current = null;
      if (recording.cancelled) {
        setPhase("idle");
        return;
      }
      const mimeType = recorder.mimeType || "audio/webm";
      void transcribe(new Blob(recording.chunks, { type: mimeType }), mimeType);
    });
    recordingRef.current = recording;
    recorder.start();
    setElapsed(0);
    setPhase("recording");
  };

  function stop() {
    const recording = recordingRef.current;
    if (recording && recording.recorder.state !== "inactive") recording.recorder.stop();
  }

  const cancel = () => {
    const recording = recordingRef.current;
    if (!recording) return;
    recording.cancelled = true;
    stop();
  };

  const label =
    phase === "recording"
      ? "Stop and transcribe"
      : phase === "transcribing"
        ? "Transcribing"
        : "Dictate";

  return (
    <div className="flex items-center gap-1">
      {phase === "recording" ? (
        <>
          <span className="text-muted-foreground text-xs tabular-nums">
            {Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, "0")}
          </span>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  aria-label="Cancel dictation"
                  onClick={cancel}
                  type="button"
                  size="icon-sm"
                  variant="ghost-muted"
                />
              }
            >
              <XIcon className="size-4" />
            </TooltipTrigger>
            <TooltipPopup>
              <p>Cancel dictation</p>
            </TooltipPopup>
          </Tooltip>
        </>
      ) : null}
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              aria-label={label}
              aria-pressed={phase === "recording"}
              disabled={phase === "transcribing" || (phase === "idle" && props.disabled)}
              onClick={() => (phase === "recording" ? stop() : void start())}
              type="button"
              size="icon-sm"
              variant={phase === "recording" ? "ghost-destructive" : "ghost-muted"}
            />
          }
        >
          {phase === "transcribing" ? (
            <LoaderIcon className="size-4 animate-spin" />
          ) : phase === "recording" ? (
            <SquareIcon className="size-3.5 animate-pulse fill-current" />
          ) : (
            <MicIcon className="size-4" />
          )}
        </TooltipTrigger>
        <TooltipPopup>
          <p>{label}</p>
        </TooltipPopup>
      </Tooltip>
    </div>
  );
}
