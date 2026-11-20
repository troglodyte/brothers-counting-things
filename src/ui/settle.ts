// Steadies the live count. Each frame is counted from scratch, so hand shake
// makes the number flicker (22, 23, 24...). This keeps the last couple of
// seconds of frames and reports the count most of them agree on, weighted by
// confidence. That is a vote, not a mean: one blurred frame reading 31 cannot
// drag 23 up to 25. The count only changes once another count clearly leads,
// and the history starts over when the found line moves to a different stack.
// Voting removes random jitter only; a mistake every frame makes (an end item
// missed each time) stays, it just stops flickering.

import type { Confidence } from '../algorithm/count';
import type { Line } from '../algorithm/profile';

export interface LiveFrame {
  count: number;
  confidence: Confidence;
  /** First item centre to last item centre, in source pixels. */
  line: Line;
}

export interface Settled<F extends LiveFrame> {
  count: number;
  confidence: Confidence;
  /** Median of the lines of the frames that voted for `count`. */
  line: Line;
  /** Enough frames, and most of the vote on `count`. */
  steady: boolean;
  /** The newest frame that voted for `count` (its ticks are drawn). */
  latest: F;
}

/** How far back frames vote. */
export const WINDOW_MS = 2000;
/** Frames needed, and the share of the vote the count needs, to call it steady. */
export const STEADY_FRAMES = 5;
export const STEADY_SHARE = 0.6;
/** A new count replaces the shown one once its vote is this many times bigger. */
const SWITCH_RATIO = 1.5;
/** A line whose ends move more than this share of its length is another stack... */
const MOVED = 0.25;
/** ...once this many frames in a row say so (one bad frame does not reset). */
const MOVED_FRAMES = 3;

const WEIGHT: Record<Confidence, number> = { good: 1, check: 0.5, low: 0.25 };

interface Entry<F> {
  t: number;
  frame: F | null;
}

export class Settler<F extends LiveFrame> {
  private history: Entry<F>[] = [];
  /** Consecutive frames far from the settled line: the next stack, if they keep coming. */
  private moved: Entry<F>[] = [];
  private shown: number | null = null;

  reset(): void {
    this.history = [];
    this.moved = [];
    this.shown = null;
  }

  /** Add one frame's result (`null`: nothing found) taken at time `t` ms. */
  push(frame: F | null, t: number): void {
    const now = this.settled();
    if (frame && now && moved(now.line, frame.line)) {
      this.moved.push({ t, frame });
      if (this.moved.length >= MOVED_FRAMES) {
        this.history = this.moved;
        this.moved = [];
        this.shown = null;
      }
    } else {
      this.moved = [];
      this.history.push({ t, frame });
    }
    this.history = this.history.filter((e) => e.t > t - WINDOW_MS);
  }

  settled(): Settled<F> | null {
    const votes = new Map<number, number>();
    let total = 0;
    let frames = 0;
    for (const { frame } of this.history) {
      if (!frame) continue;
      const w = WEIGHT[frame.confidence];
      votes.set(frame.count, (votes.get(frame.count) ?? 0) + w);
      total += w;
      frames++;
    }
    if (frames === 0) {
      this.shown = null;
      return null;
    }
    let best = 0;
    let bestVote = -1;
    for (const [c, v] of votes) if (v > bestVote) [best, bestVote] = [c, v];
    const shownVote = this.shown === null ? 0 : votes.get(this.shown) ?? 0;
    if (shownVote === 0 || bestVote > shownVote * SWITCH_RATIO) this.shown = best;
    const count = this.shown!;
    const voters = this.history.flatMap((e) => (e.frame && e.frame.count === count ? [e.frame] : []));
    const latest = voters[voters.length - 1];
    return {
      count,
      confidence: latest.confidence,
      line: medianLine(voters.map((f) => f.line)),
      steady: frames >= STEADY_FRAMES && (votes.get(count) ?? 0) >= STEADY_SHARE * total,
      latest,
    };
  }
}

function moved(a: Line, b: Line): boolean {
  const len = Math.hypot(a.x2 - a.x1, a.y2 - a.y1) || 1;
  const d1 = Math.hypot(b.x1 - a.x1, b.y1 - a.y1);
  const d2 = Math.hypot(b.x2 - a.x2, b.y2 - a.y2);
  return Math.max(d1, d2) > MOVED * len;
}

function median(xs: number[]): number {
  const s = [...xs].sort((p, q) => p - q);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function medianLine(lines: Line[]): Line {
  return {
    x1: median(lines.map((l) => l.x1)),
    y1: median(lines.map((l) => l.y1)),
    x2: median(lines.map((l) => l.x2)),
    y2: median(lines.map((l) => l.y2)),
  };
}
