const MAX_INTERVAL_MS = 300;
const MAX_PRESS_MS = 250;
/** How far a finger may drift during one tap before it counts as a scroll or drag. */
const TAP_SLOP = 10;
/** How far apart the two taps may land. */
const MAX_TAP_DISTANCE = 32;

export interface TouchPoint {
  readonly x: number;
  readonly y: number;
  /** Milliseconds. */
  readonly time: number;
}

function distance(a: TouchPoint, b: TouchPoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Recognizes a double tap from raw touches without claiming them, so taps underneath respond at once. */
export function createDoubleTapDetector() {
  let press: TouchPoint | null = null;
  let lastTap: TouchPoint | null = null;
  return {
    /** `counts` is false for a touch that only stops a scrolling list or lands on an embed. */
    start(point: TouchPoint, touchCount: number, counts = true) {
      press = touchCount === 1 && counts ? point : null;
      if (!press) lastTap = null;
    },
    cancel() {
      press = null;
      lastTap = null;
    },
    /** True when this touch completes a double tap. */
    end(point: TouchPoint): boolean {
      const began = press;
      press = null;
      if (!began || distance(began, point) > TAP_SLOP || point.time - began.time > MAX_PRESS_MS) {
        lastTap = null;
        return false;
      }
      if (
        lastTap &&
        point.time - lastTap.time <= MAX_INTERVAL_MS &&
        distance(lastTap, point) <= MAX_TAP_DISTANCE
      ) {
        lastTap = null;
        return true;
      }
      lastTap = point;
      return false;
    },
  };
}

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const QUOTE = /^ {0,3}>/;

/** Whether the markdown has a quote or admonition line outside fenced code. */
export function hasBlockquote(markdown: string): boolean {
  let fence: string | null = null;
  for (const line of markdown.split("\n")) {
    const marker = FENCE.exec(line)?.[1];
    if (fence) {
      if (marker && marker[0] === fence[0] && marker.length >= fence.length) fence = null;
    } else if (marker) fence = marker;
    else if (QUOTE.test(line)) return true;
  }
  return false;
}
