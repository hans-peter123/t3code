import { useNavigate } from "@tanstack/react-router";
import { PLAYBACK_RATES } from "@t3tools/client-runtime/speech";
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
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import { toastManager } from "../components/ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import {
  SPEECH_SKIP_SECONDS,
  SpeechNotConfiguredError,
  seekSpeech,
  setSpeechPlaybackRate,
  speakMessage,
  stopSpeech,
  useSpeechPlayback,
} from "./speechPlayback";
import { updateSpeechSettings, useSpeechSettings } from "./speechSettings";

export function formatSpeechTime(seconds: number): string {
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

/** Starts or toggles reading a message, explaining in a toast why it cannot. */
export function readMessageAloud(
  input: { readonly messageId: string; readonly markdown: string; readonly title: string },
  openPage: (to: "/settings/voice") => void,
) {
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
  readonly messageId: string;
  readonly markdown: string;
  readonly title: string;
}) {
  const navigate = useNavigate();
  const playback = useSpeechPlayback(props.messageId);
  const settings = useSpeechSettings();

  const start = () => readMessageAloud(props, (to) => void navigate({ to }));

  if (playback.phase === "idle") {
    // Turned off in settings; with no provider yet the button still leads to setup.
    if (settings.providers.length > 0 && !settings.activeProviderId) return null;
    return (
      <SpeechControlButton
        label="Read aloud"
        disabled={props.markdown.trim().length === 0}
        onClick={start}
      >
        <Volume2Icon className="size-3" />
      </SpeechControlButton>
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
      {preparing || playback.buffering ? (
        <SpeechControlButton label="Preparing audio" disabled onClick={() => {}}>
          <LoaderIcon className="size-3 animate-spin" />
        </SpeechControlButton>
      ) : (
        <SpeechControlButton
          label={playback.phase === "playing" ? "Pause" : "Resume"}
          onClick={start}
        >
          {playback.phase === "playing" ? (
            <PauseIcon className="size-3" />
          ) : (
            <PlayIcon className="size-3" />
          )}
        </SpeechControlButton>
      )}
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
      {preparing ? null : (
        <span className="ml-1 text-muted-foreground text-xs tabular-nums">
          {formatSpeechTime(playback.currentTime)} / {formatSpeechTime(playback.duration)}
        </span>
      )}
      <PlaybackRateSelect rate={settings.playbackRate} />
    </div>
  );
});
