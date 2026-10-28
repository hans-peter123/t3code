import { useNavigate } from "@tanstack/react-router";
import { activeSpeechProvider } from "@t3tools/client-runtime/speech";
import {
  LoaderIcon,
  PauseIcon,
  PlayIcon,
  RotateCcwIcon,
  RotateCwIcon,
  SquareIcon,
  Volume2Icon,
} from "lucide-react";

import { ThreadDetailsControl } from "../components/chat/ThreadDetailsControl";
import { ThreadDetailsSection } from "../components/chat/ThreadDetailsSection";
import {
  THREAD_DETAILS_PANEL_ICON_CLASS,
  THREAD_DETAILS_PANEL_ROW_CONTENT_CLASS,
} from "../components/chat/threadDetailsPanelStyles";
import { Switch } from "../components/ui/switch";
import { cn } from "../lib/utils";
import { formatSpeechTime, PlaybackRateSelect, SpeechControlButton } from "./ReadAloudButton";
import {
  SPEECH_SKIP_SECONDS,
  seekSpeech,
  stopSpeech,
  toggleSpeechPause,
  useSpeechPlaybackState,
} from "./speechPlayback";
import { updateSpeechSettings, useSpeechSettings } from "./speechSettings";

/** The "Read new replies" switch, which expands into a small player while a reply is read. */
export function ThreadReadAloudSection() {
  const navigate = useNavigate();
  const settings = useSpeechSettings();
  const playback = useSpeechPlaybackState();
  // Read aloud switched off in Voice settings hides it everywhere.
  if (settings.providers.length > 0 && !settings.activeProviderId) return null;
  const ready = activeSpeechProvider(settings) !== null;
  const active = playback.phase !== "idle";
  const preparing = playback.phase === "preparing";

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
          {active && !preparing ? (
            <span className="shrink-0 text-2xs font-normal tabular-nums text-muted-foreground">
              {formatSpeechTime(playback.currentTime)} / {formatSpeechTime(playback.duration)}
            </span>
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
            {preparing || playback.buffering ? (
              <SpeechControlButton label="Preparing audio" disabled onClick={() => {}}>
                <LoaderIcon className="size-3 animate-spin" />
              </SpeechControlButton>
            ) : (
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
            <div className="ml-auto">
              <PlaybackRateSelect rate={settings.playbackRate} />
            </div>
          </div>
        </div>
      ) : null}
    </ThreadDetailsSection>
  );
}
