import { useNavigate } from "@tanstack/react-router";
import {
  HANDS_FREE_COPY,
  PLAYBACK_RATES,
  shownSpeechMode,
  type SpeechReadMode,
} from "@t3tools/client-runtime/speech";
import type { MessageId, ScopedThreadRef } from "@t3tools/contracts";
import {
  HourglassIcon,
  LoaderIcon,
  PauseIcon,
  PlayIcon,
  RotateCcwIcon,
  RotateCwIcon,
  SquareIcon,
  Volume2Icon,
  XIcon,
} from "lucide-react";
import { memo, type ReactNode } from "react";

import { Button } from "../components/ui/button";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import { toastManager } from "../components/ui/toast";
import { Toggle, ToggleGroup } from "../components/ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import { cn } from "../lib/utils";
import {
  SPEECH_SKIP_SECONDS,
  SpeechNotConfiguredError,
  seekSpeech,
  setSpeechPlaybackRate,
  speakMessage,
  type SpeechPlaybackState,
  type SpeechRequest,
  stopSpeech,
  toggleSpeechPause,
  useSpeechPlayback,
} from "./speechPlayback";
import { currentSpeechSettings, updateSpeechSettings, useSpeechSettings } from "./speechSettings";
import { loadSpokenSummary, noteSpokenSummaryFailure, useCanSummarize } from "./spokenSummary";

function formatSpeechTime(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

export function SpeechControlButton(props: {
  readonly label: string;
  readonly disabled?: boolean;
  readonly onClick: () => void;
  readonly children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            aria-label={props.label}
            disabled={props.disabled}
            onClick={props.onClick}
            type="button"
            size="icon-xs"
            variant="ghost-muted"
          />
        }
      >
        {props.children}
      </TooltipTrigger>
      <TooltipPopup>
        <p>{props.label}</p>
      </TooltipPopup>
    </Tooltip>
  );
}

export function PlaybackRateSelect(props: { readonly rate: number }) {
  return (
    <Select
      value={String(props.rate)}
      onValueChange={(value) => {
        const playbackRate = Number(value);
        setSpeechPlaybackRate(playbackRate);
        void updateSpeechSettings((current) => ({ ...current, playbackRate }));
      }}
    >
      <SelectTrigger variant="ghost" size="compact" aria-label="Playback speed">
        <SelectValue>{`${props.rate}×`}</SelectValue>
      </SelectTrigger>
      <SelectPopup>
        {PLAYBACK_RATES.map((rate) => (
          <SelectItem key={rate} hideIndicator value={String(rate)}>
            {`${rate}×`}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

const WRITING_SHORT_LABEL = "Writing short version";

/** Position in the reply; while Short is written, the label replaces it only when nothing plays. */
export function SpeechProgressLabel(props: {
  readonly playback: SpeechPlaybackState;
  readonly className: string;
}) {
  const { playback, className } = props;
  const preparing = playback.phase === "preparing";
  if (preparing) {
    return playback.writingShort ? <span className={className}>{WRITING_SHORT_LABEL}</span> : null;
  }
  return (
    <span className={cn("inline-flex items-center gap-1 tabular-nums", className)}>
      {formatSpeechTime(playback.currentTime)} / {formatSpeechTime(playback.duration)}
      {playback.writingShort ? (
        <HourglassIcon role="img" aria-label={WRITING_SHORT_LABEL} className="size-3">
          <title>{WRITING_SHORT_LABEL}</title>
        </HourglassIcon>
      ) : null}
    </span>
  );
}

/** Pause and resume, or what playback waits for while there is nothing to play yet. */
export function SpeechPlayPauseButton(props: { readonly playback: SpeechPlaybackState }) {
  const { playback } = props;
  // The summary can take most of a minute, so it gets a still icon rather than a long spin.
  if (playback.phase === "preparing" && playback.writingShort) {
    return (
      <SpeechControlButton label={WRITING_SHORT_LABEL} disabled onClick={() => {}}>
        <HourglassIcon className="size-3" />
      </SpeechControlButton>
    );
  }
  if (playback.phase === "preparing" || playback.buffering) {
    return (
      <SpeechControlButton label="Preparing audio" disabled onClick={() => {}}>
        <LoaderIcon className="size-3 animate-spin" />
      </SpeechControlButton>
    );
  }
  return (
    <SpeechControlButton
      label={playback.phase === "playing" ? "Pause" : "Resume"}
      onClick={toggleSpeechPause}
    >
      {playback.phase === "playing" ? (
        <PauseIcon className="size-3" />
      ) : (
        <PlayIcon className="size-3" />
      )}
    </SpeechControlButton>
  );
}

/** Switches the message being read between its short version and the full reply. */
export function SpeechModeToggle(props: {
  readonly mode: SpeechReadMode;
  readonly onChange: (mode: SpeechReadMode) => void;
}) {
  return (
    <ToggleGroup
      aria-label="Read aloud version"
      variant="segmented"
      value={[props.mode]}
      onValueChange={(value) => {
        const next = value[0];
        if ((next === "short" || next === "full") && next !== props.mode) props.onChange(next);
      }}
    >
      <Toggle aria-label="Short version" value="short">
        Short
      </Toggle>
      <Toggle aria-label="Full reply" value="full">
        Full
      </Toggle>
    </ToggleGroup>
  );
}

/**
 * What reading a reply plays. Replies of a server thread can be read as its spoken summary;
 * drafts, and threads this connection may not summarize, always play in full.
 */
export function replySpeechRequest(input: {
  readonly messageId: MessageId;
  readonly markdown: string;
  readonly title: string;
  readonly threadRef: ScopedThreadRef | null;
  readonly mode?: SpeechReadMode;
}): SpeechRequest {
  const { threadRef, messageId } = input;
  return {
    messageId,
    markdown: input.markdown,
    title: input.title,
    mode: input.mode ?? currentSpeechSettings().readMode,
    ...(threadRef
      ? {
          threadRef,
          loadSummary: () => loadSpokenSummary({ ...threadRef, messageId }),
          onShortUnavailable: (error: unknown, chosen: boolean) => {
            // Passive reads tell once per environment; a switch to Short always gets an answer.
            if (noteSpokenSummaryFailure(threadRef.environmentId, error) || chosen) {
              toastManager.add({ type: "info", title: HANDS_FREE_COPY.shortUnavailable });
            }
          },
        }
      : {}),
  };
}

/** Starts or toggles reading a message, explaining in a toast why it cannot. */
export function readMessageAloud(input: SpeechRequest, openPage: (to: "/settings/voice") => void) {
  speakMessage(input).catch((error: unknown) => {
    if (error instanceof SpeechNotConfiguredError) {
      toastManager.add({
        type: "info",
        title: "Set up read aloud",
        description: error.message,
        actionProps: { children: "Open settings", onClick: () => openPage("/settings/voice") },
      });
      return;
    }
    toastManager.add({
      type: "error",
      title: "Could not read aloud",
      description: error instanceof Error ? error.message : "Try again.",
    });
  });
}

/** Reads an assistant message aloud; expands into transport controls while it is loaded. */
export const ReadAloudButton = memo(function ReadAloudButton(props: {
  readonly messageId: MessageId;
  readonly markdown: string;
  readonly title: string;
  readonly threadRef: ScopedThreadRef | null;
}) {
  const navigate = useNavigate();
  const playback = useSpeechPlayback(props.messageId);
  const settings = useSpeechSettings();
  const canSummarize = useCanSummarize(props.threadRef?.environmentId ?? null);
  const threadRef = canSummarize ? props.threadRef : null;

  const start = (mode?: SpeechReadMode) =>
    readMessageAloud(
      replySpeechRequest({ ...props, threadRef, ...(mode === undefined ? {} : { mode }) }),
      (to) => void navigate({ to }),
    );

  if (playback.phase === "idle") {
    // Turned off in settings; with no provider yet the button still leads to setup.
    if (settings.providers.length > 0 && !settings.activeProviderId) return null;
    return (
      <div className="flex items-center">
        <SpeechControlButton
          label="Read aloud"
          disabled={props.markdown.trim().length === 0}
          onClick={() => start()}
        >
          <Volume2Icon className="size-3" />
        </SpeechControlButton>
        {playback.fullOffer ? (
          <>
            <Button size="xs" variant="ghost-muted" onClick={() => start("full")}>
              Read full reply
            </Button>
            <SpeechControlButton label="Dismiss" onClick={stopSpeech}>
              <XIcon className="size-3" />
            </SpeechControlButton>
          </>
        ) : null}
      </div>
    );
  }

  const preparing = playback.phase === "preparing";
  return (
    <div className="flex items-center">
      <SpeechControlButton
        label={`Back ${SPEECH_SKIP_SECONDS} seconds`}
        disabled={preparing}
        onClick={() => seekSpeech(-SPEECH_SKIP_SECONDS)}
      >
        <RotateCcwIcon className="size-3" />
      </SpeechControlButton>
      <SpeechPlayPauseButton playback={playback} />
      <SpeechControlButton
        label={`Forward ${SPEECH_SKIP_SECONDS} seconds`}
        disabled={preparing}
        onClick={() => seekSpeech(SPEECH_SKIP_SECONDS)}
      >
        <RotateCwIcon className="size-3" />
      </SpeechControlButton>
      <SpeechControlButton label="Stop reading" onClick={stopSpeech}>
        <SquareIcon className="size-2.5" />
      </SpeechControlButton>
      <SpeechProgressLabel playback={playback} className="ml-1 text-muted-foreground text-xs" />
      {playback.shortAvailable ? (
        <div className="ml-1">
          <SpeechModeToggle mode={shownSpeechMode(playback)} onChange={start} />
        </div>
      ) : null}
      <PlaybackRateSelect rate={settings.playbackRate} />
    </div>
  );
});
