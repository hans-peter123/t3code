import { useNavigate } from "@tanstack/react-router";
import {
  activeSpeechProvider,
  shownSpeechMode,
  type SpeechReadMode,
} from "@t3tools/client-runtime/speech";
import type { ScopedThreadRef } from "@t3tools/contracts";
import {
  PlayIcon,
  RotateCcwIcon,
  RotateCwIcon,
  SquareIcon,
  Volume2Icon,
  XIcon,
} from "lucide-react";

import { ThreadDetailsControl } from "../components/chat/ThreadDetailsControl";
import { ThreadDetailsSection } from "../components/chat/ThreadDetailsSection";
import {
  THREAD_DETAILS_PANEL_ICON_CLASS,
  THREAD_DETAILS_PANEL_ROW_CONTENT_CLASS,
} from "../components/chat/threadDetailsPanelStyles";
import { Button } from "../components/ui/button";
import { Switch } from "../components/ui/switch";
import { cn } from "../lib/utils";
import {
  PlaybackRateSelect,
  readMessageAloud,
  SpeechControlButton,
  SpeechModeToggle,
  SpeechPlayPauseButton,
  SpeechProgressLabel,
} from "./ReadAloudButton";
import {
  currentSpeechRequest,
  SPEECH_SKIP_SECONDS,
  seekSpeech,
  stopSpeech,
  useSpeechPlaybackState,
} from "./speechPlayback";
import { updateSpeechSettings, useSpeechSettings } from "./speechSettings";

/** The "Read new replies" switch, which expands into a small player while a reply is read. */
export function ThreadReadAloudSection(props: { readonly threadRef: ScopedThreadRef }) {
  const navigate = useNavigate();
  const settings = useSpeechSettings();
  const playback = useSpeechPlaybackState();
  // Read aloud switched off in Voice settings hides it everywhere.
  if (settings.providers.length > 0 && !settings.activeProviderId) return null;
  const ready = activeSpeechProvider(settings) !== null;
  const active = playback.phase !== "idle";
  const preparing = playback.phase === "preparing";
  const request = currentSpeechRequest();
  const readAs = (mode: SpeechReadMode) => {
    if (request) readMessageAloud({ ...request, mode }, (to) => void navigate({ to }));
  };
  // The offer names no thread, so it shows only beside the thread whose reply was read.
  const fullOffer =
    playback.fullOffer &&
    request?.threadRef?.environmentId === props.threadRef.environmentId &&
    request.threadRef.threadId === props.threadRef.threadId;

  return (
    <ThreadDetailsSection
      headingId="thread-details-read-aloud-heading"
      title="Read aloud"
      showHeading={false}
    >
      {ready ? (
        <label
          className={cn(
            "flex h-8 cursor-pointer items-center rounded-lg text-sm font-medium text-foreground/80",
            THREAD_DETAILS_PANEL_ROW_CONTENT_CLASS,
          )}
        >
          <Volume2Icon aria-hidden className={THREAD_DETAILS_PANEL_ICON_CLASS} />
          <span className="min-w-0 flex-1 truncate">Read new replies</span>
          {active ? (
            <SpeechProgressLabel
              playback={playback}
              className="shrink-0 text-2xs font-normal text-muted-foreground"
            />
          ) : null}
          <Switch
            size="sm"
            checked={settings.autoRead}
            onCheckedChange={(autoRead) =>
              void updateSpeechSettings((current) => ({ ...current, autoRead }))
            }
          />
        </label>
      ) : (
        <ThreadDetailsControl
          size="sm"
          variant="ghost"
          part="row"
          onClick={() => void navigate({ to: "/settings/voice" })}
        >
          <Volume2Icon aria-hidden className={THREAD_DETAILS_PANEL_ICON_CLASS} />
          <span className="min-w-0 flex-1 truncate">Set up read aloud</span>
        </ThreadDetailsControl>
      )}

      {active ? (
        <div className="px-2.5 pt-1">
          <div
            className="h-1 overflow-hidden rounded-full bg-foreground/10"
            role="progressbar"
            aria-label="Read aloud progress"
            aria-valuemin={0}
            aria-valuemax={Math.round(playback.duration)}
            aria-valuenow={Math.round(playback.currentTime)}
          >
            <div
              className="h-full rounded-full bg-primary"
              style={{
                width: `${playback.duration > 0 ? Math.min(100, (playback.currentTime / playback.duration) * 100) : 0}%`,
              }}
            />
          </div>
          <div className="-mx-1 mt-1 flex items-center">
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
            <div className="ml-auto flex items-center gap-1">
              {playback.shortAvailable ? (
                <SpeechModeToggle mode={shownSpeechMode(playback)} onChange={readAs} />
              ) : null}
              <PlaybackRateSelect rate={settings.playbackRate} />
            </div>
          </div>
        </div>
      ) : fullOffer ? (
        <div className="flex items-center justify-between px-1.5 pt-1">
          <Button size="xs" variant="ghost" onClick={() => readAs("full")}>
            <PlayIcon />
            Read full reply
          </Button>
          <SpeechControlButton label="Dismiss" onClick={stopSpeech}>
            <XIcon className="size-3" />
          </SpeechControlButton>
        </div>
      ) : null}
    </ThreadDetailsSection>
  );
}
