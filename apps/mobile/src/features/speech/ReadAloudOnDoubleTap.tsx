import * as Haptics from "expo-haptics";
import {
  createContext,
  use,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { View, type GestureResponderEvent } from "react-native";
import Animated, { Keyframe } from "react-native-reanimated";

import { useReduceMotionEnabled } from "../../lib/appState";
import { conversationHoldsAudioSession } from "../../lib/audioSession";
import { explainAudioSessionRefusal } from "../../lib/audioSessionRefusal";
import { createDoubleTapDetector } from "./doubleTap";
import { speechPlaybackOf, toggleSpeechPause, useSpeechLoaded } from "./speechPlayback";
import { useSpeechSettings } from "./speechSettings";
import { type ReplyToRead, useReadReplyAloud } from "./SpeakMessageButton";

const FLASH_MS = 520;
const FLASH = new Keyframe({ 0: { opacity: 0 }, 20: { opacity: 1 }, 100: { opacity: 0 } }).duration(
  FLASH_MS,
);
const FLASH_INSETS = { top: -4, bottom: -4, left: -6, right: -6 } as const;
/** How long selection stays off after a double tap, so iOS drops the word it selected on it. */
const SELECTION_CLEAR_MS = 150;
/** A touch this soon after the list moved is stopping a scroll, not tapping a reply. */
const SCROLL_SETTLE_MS = 100;

export interface DoubleTapToRead {
  readonly onTouchStart: (event: GestureResponderEvent) => void;
  readonly onTouchEnd: (event: GestureResponderEvent) => void;
  readonly onTouchCancel: () => void;
  /** A link, image, or code block button inside the text handled the tap. */
  readonly onInnerPress: () => void;
  readonly selectable: boolean;
}

const DoubleTapToReadContext = createContext<DoubleTapToRead | null>(null);

/** Touch handlers for the markdown text view of a reply; null when double tap does nothing. */
export function useDoubleTapToRead() {
  return use(DoubleTapToReadContext);
}

function touchPoint(event: GestureResponderEvent) {
  const { pageX, pageY, timestamp } = event.nativeEvent;
  return { x: pageX, y: pageY, time: timestamp };
}

/**
 * Double tap on the reply's text reads it aloud, or pauses and resumes it while it is the one
 * loaded. The text view observes touches without claiming them, and only touches on the text view
 * itself count, so embeds and cards keep their own taps.
 */
export function ReadAloudOnDoubleTap(
  props: ReplyToRead & {
    /** Off while the reply streams; the wrapper stays so the content does not remount. */
    readonly enabled: boolean;
    /** When the user last scrolled the feed, in `Date.now()` milliseconds. */
    readonly listScrolledAt: RefObject<number>;
    readonly children: ReactNode;
  },
) {
  const { messageId, markdown, title, threadRef, listScrolledAt } = props;
  const loaded = useSpeechLoaded(messageId);
  const settings = useSpeechSettings();
  // Keyed on the reply fields, not `props`, so row re-renders keep the context value and the
  // memoized markdown segments below it still.
  const reply = useMemo(
    () => ({ messageId, markdown, title, threadRef }),
    [messageId, markdown, title, threadRef],
  );
  const { start } = useReadReplyAloud(reply);
  const reduceMotion = useReduceMotionEnabled();
  const [detector] = useState(createDoubleTapDetector);
  const [flash, setFlash] = useState(0);
  const [clearingSelection, setClearingSelection] = useState(false);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Setup is left to the speaker button, so without a reader double tap keeps selecting words.
  const available =
    props.enabled && settings.doubleTapToRead && (loaded || Boolean(settings.activeProviderId));

  const handlers = useMemo((): DoubleTapToRead | null => {
    if (!available) return null;
    const acknowledge = () => {
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      if (flashTimer.current) clearTimeout(flashTimer.current);
      setFlash((count) => count + 1);
      flashTimer.current = setTimeout(() => setFlash(0), FLASH_MS);
    };
    const read = () => {
      setClearingSelection(true);
      setTimeout(() => setClearingSelection(false), SELECTION_CLEAR_MS);
      if (conversationHoldsAudioSession()) {
        explainAudioSessionRefusal("read aloud");
        return;
      }
      acknowledge();
      const playback = speechPlaybackOf(messageId);
      if (playback.phase === "preparing" || playback.buffering) return;
      if (playback.phase !== "idle") toggleSpeechPause();
      else start();
    };
    return {
      onTouchStart: (event) => {
        const counts =
          event.target === event.currentTarget &&
          Date.now() - listScrolledAt.current > SCROLL_SETTLE_MS;
        detector.start(touchPoint(event), event.nativeEvent.touches.length, counts);
      },
      onTouchEnd: (event) => {
        if (detector.end(touchPoint(event))) read();
      },
      onTouchCancel: detector.cancel,
      onInnerPress: detector.cancel,
      selectable: !clearingSelection,
    };
  }, [available, clearingSelection, detector, listScrolledAt, messageId, start]);

  return (
    <View>
      {flash > 0 ? (
        reduceMotion ? (
          <View
            pointerEvents="none"
            className="absolute rounded-xl bg-subtle"
            style={FLASH_INSETS}
          />
        ) : (
          <Animated.View
            key={flash}
            entering={FLASH}
            pointerEvents="none"
            className="absolute rounded-xl bg-subtle"
            style={FLASH_INSETS}
          />
        )
      ) : null}
      <DoubleTapToReadContext value={handlers}>{props.children}</DoubleTapToReadContext>
    </View>
  );
}
