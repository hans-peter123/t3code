import { useNavigate } from "@tanstack/react-router";
import {
  LoaderIcon,
  PauseIcon,
  PlayIcon,
  RotateCcwIcon,
  RotateCwIcon,
  SquareIcon,
  Volume2Icon,
} from "lucide-react";
import { memo, type ReactNode } from "react";

import { Button } from "../components/ui/button";
import { toastManager } from "../components/ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import {
  SPEECH_SKIP_SECONDS,
  SpeechNotConfiguredError,
  seekSpeech,
  speakMessage,
  stopSpeech,
  useSpeechPlayback,
} from "./speechPlayback";
import { useSpeechSettings } from "./speechSettings";

function formatTime(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

function ControlButton(props: {
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

/** Reads an assistant message aloud; expands into transport controls while it is loaded. */
export const ReadAloudButton = memo(function ReadAloudButton(props: {
  readonly messageId: string;
  readonly markdown: string;
  readonly title: string;
}) {
  const navigate = useNavigate();
  const playback = useSpeechPlayback(props.messageId);
  const settings = useSpeechSettings();

  const start = () => {
    speakMessage(props).catch((error: unknown) => {
      if (error instanceof SpeechNotConfiguredError) {
        toastManager.add({
          type: "info",
          title: "Set up read aloud",
          description: error.message,
          actionProps: {
            children: "Open settings",
            onClick: () => void navigate({ to: "/settings/voice" }),
          },
        });
        return;
      }
      toastManager.add({
        type: "error",
        title: "Could not read aloud",
        description: error instanceof Error ? error.message : "Try again.",
      });
    });
  };

  if (playback.phase === "idle") {
    // Turned off in settings; with no provider yet the button still leads to setup.
    if (settings.providers.length > 0 && !settings.activeProviderId) return null;
    return (
      <ControlButton
        label="Read aloud"
        disabled={props.markdown.trim().length === 0}
        onClick={start}
      >
        <Volume2Icon className="size-3" />
      </ControlButton>
    );
  }

  const preparing = playback.phase === "preparing";
  return (
    <div className="flex items-center">
      <ControlButton
        label={`Back ${SPEECH_SKIP_SECONDS} seconds`}
        disabled={preparing}
        onClick={() => seekSpeech(-SPEECH_SKIP_SECONDS)}
      >
        <RotateCcwIcon className="size-3" />
      </ControlButton>
      {preparing || playback.buffering ? (
        <ControlButton label="Preparing audio" disabled onClick={() => {}}>
          <LoaderIcon className="size-3 animate-spin" />
        </ControlButton>
      ) : (
        <ControlButton label={playback.phase === "playing" ? "Pause" : "Resume"} onClick={start}>
          {playback.phase === "playing" ? (
            <PauseIcon className="size-3" />
          ) : (
            <PlayIcon className="size-3" />
          )}
        </ControlButton>
      )}
      <ControlButton
        label={`Forward ${SPEECH_SKIP_SECONDS} seconds`}
        disabled={preparing}
        onClick={() => seekSpeech(SPEECH_SKIP_SECONDS)}
      >
        <RotateCwIcon className="size-3" />
      </ControlButton>
      <ControlButton label="Stop reading" onClick={stopSpeech}>
        <SquareIcon className="size-2.5" />
      </ControlButton>
      {preparing ? null : (
        <span className="ml-1 text-muted-foreground text-xs tabular-nums">
          {formatTime(playback.currentTime)} / {formatTime(playback.duration)}
        </span>
      )}
    </div>
  );
});
