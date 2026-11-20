// Find the stack on a fixed guide line, so the live viewfinder can count
// without the user marking the first and last item.
//
// Pass 1 (here): the stack is where the stripe pattern has energy and where
// the colours look like the middle of the guide line (the user aims the
// middle at the stack). Pass 2 (the caller): the ordinary count on a line
// between the found end items, so the period is measured on the stack alone;
// over the whole guide line the background skews it.
//
// harness/autoends.ts measures this on the real photos: 17/18 within
// tolerance with the guide 15-50% longer than the stack, no wrong "good".

import { lookSimilarity, stackLook } from './appearance';
import { windowedPeriod } from './period';
import { estimateStripeAngle, sampleProfile, toGray, type ImageLike, type Line, type StripGeometry } from './profile';
import { boxSmooth, median } from './signal';

export interface AutoEndsOptions {
  /** Energy window, in local periods. */
  win?: number;
  /** The stack's edge is where the energy falls below this share of its level. */
  half?: number;
  /** Energy dips shorter than this many periods are bridged. */
  bridge?: number;
  /** Energy past a bridged dip must last this many periods to count as stack (a lone background step gives about one). */
  minRun?: number;
  /** Periods trimmed off each energy edge (the stack/background step adds energy of its own). */
  trim?: number;
  /** Colour similarity an item-sized slice needs to the middle third to count as stack. 0 turns the look check off. */
  look?: number;
  /** Dissimilar slices in a row that end the stack. */
  lookRun?: number;
}

export const AUTO_DEFAULTS: Required<AutoEndsOptions> = { win: 1, half: 0.5, bridge: 3, minRun: 1.5, trim: 1, look: 0.2, lookRun: 2 };

export interface FoundEnds {
  /** Centres of the first and last item, in px along the guide line from its start. */
  start: number;
  end: number;
}

/**
 * Find the stack on a straightened RGBA strip of the guide line (see
 * StripGeometry). Null when no stripe pattern is found or the run is too short.
 */
export function findEnds(strip: ImageLike, geom: StripGeometry, opts: AutoEndsOptions = {}): FoundEnds | null {
  const o = { ...AUTO_DEFAULTS, ...opts };
  const gray = toGray(strip);
  const angle = estimateStripeAngle(gray, geom);
  const ext = geom.margin;
  const profile = sampleProfile(gray, geom, angle.angle, 6, ext);
  const per = windowedPeriod(profile, ext, geom.length, { periodsPerWindow: 25 });
  if (!per) return null;
  const P = per.periodAt;
  const d = per.detrended;
  const n = d.length;
  const lo = ext;
  const hi = ext + geom.length;
  const mid = Math.round(ext + geom.length / 2);

  // Stripe energy: RMS of the detrended profile over `win` periods.
  const sq = new Float32Array(n);
  for (let i = 0; i < n; i++) sq[i] = d[i] * d[i];
  const en = boxSmooth(sq, Math.max(3, Math.round(o.win * P(mid)))).map(Math.sqrt);
  const ref = median(Array.from(en.subarray(Math.round(ext + geom.length / 3), Math.round(ext + (2 * geom.length) / 3))));
  const thr = o.half * ref;

  // Walk out from the middle while the energy stays above the threshold, bridging short
  // dips. A blurred step crosses half its height at the step, so the crossing is the edge.
  // Past a dip, the energy only counts once it lasts `minRun` periods: more stack goes on
  // for several items, while a lone step in the background (a shadow edge on the shelf)
  // has about one period of energy. Gaps under half a period are ripple, not dips.
  const walk = (dir: 1 | -1, from: number, to: number): number => {
    let i = mid;
    let lastIn = mid; // last index of the accepted stack
    let lastAbove = mid; // last index above the threshold, accepted or not
    let pendingFrom = NaN; // start of energy past a dip that has not yet lasted minRun periods
    while (i + dir >= from && i + dir <= to) {
      i += dir;
      if (en[i] >= thr) {
        if (Math.abs(i - lastAbove) > 0.5 * P(i) && Number.isNaN(pendingFrom)) pendingFrom = i;
        lastAbove = i;
        if (Number.isNaN(pendingFrom) || Math.abs(i - pendingFrom) >= o.minRun * P(i)) {
          lastIn = i;
          pendingFrom = NaN;
        }
      } else if (Math.abs(i - lastAbove) > o.bridge * P(i)) break;
    }
    const j = lastIn + dir;
    if (j < 0 || j >= n || en[j] >= thr) return lastIn;
    return lastIn + (dir * (en[lastIn] - thr)) / (en[lastIn] - en[j]);
  };
  let A = walk(-1, lo, hi);
  let B = walk(1, lo, hi);

  // Look bound: step out one item-sized slice at a time while the slice's colours
  // resemble the middle third's. Textured surroundings (a table, the stack behind)
  // have stripe energy too, but not the stack's colours. The look only bounds the
  // energy walk, one period past the last stack-like slice; the energy still places
  // the edge, which slices (an item wide, at any phase) cannot.
  if (o.look > 0) {
    const lookOf = (a: number, b: number) => stackLook(strip, { margin: a, length: b - a, halfHeight: geom.halfHeight });
    const ref = lookOf(ext + geom.length / 3, ext + (2 * geom.length) / 3);
    if (ref) {
      const lookWalk = (dir: 1 | -1): number => {
        let x = mid;
        let edge = mid;
        let bad = 0;
        for (;;) {
          const nx = x + dir * P(x);
          if (nx < lo || nx > hi) return dir > 0 ? hi : lo;
          const l = lookOf(Math.min(x, nx), Math.max(x, nx));
          if (l && lookSimilarity(l, ref) >= o.look) {
            edge = nx;
            bad = 0;
          } else if (++bad >= o.lookRun) return edge;
          x = nx;
        }
      };
      const la = lookWalk(-1);
      const lb = lookWalk(1);
      if (la - P(la) > A) A = walk(-1, Math.round(la - P(la)), hi);
      if (lb + P(lb) < B) B = walk(1, lo, Math.round(lb + P(lb)));
    }
  }

  A += o.trim * P(A);
  B -= o.trim * P(B);
  // End item centres, half a period in from the outer edges.
  const start = A + P(A) / 2 - ext;
  const end = B - P(B) / 2 - ext;
  // At least two items' worth, or there is nothing to count.
  if (!(end - start >= P(mid))) return null;
  return { start, end };
}

/** The part of `guide` from `start` to `end` px along it. */
export function subLine(guide: Line, ends: FoundEnds): Line {
  const L = Math.hypot(guide.x2 - guide.x1, guide.y2 - guide.y1) || 1;
  const ux = (guide.x2 - guide.x1) / L;
  const uy = (guide.y2 - guide.y1) / L;
  return {
    x1: guide.x1 + ends.start * ux,
    y1: guide.y1 + ends.start * uy,
    x2: guide.x1 + ends.end * ux,
    y2: guide.y1 + ends.end * uy,
  };
}

/**
 * The live viewfinder's guide: down the middle of a w x h frame, top to
 * bottom (first item at the top, as the user draws it), leaving 4% at each end.
 */
export function guideLine(w: number, h: number): Line {
  return { x1: w / 2, y1: 0.04 * h, x2: w / 2, y2: 0.96 * h };
}
