// Combine the period count and the peak cross-check into one answer.

import { countPeaks, halfPeriodEvidence } from './peaks';
import { scalePeriod, windowedPeriod, type PeriodResult, type PeriodWindow } from './period';
import {
  estimateStripeAngle,
  extractStrip,
  sampleProfile,
  stripGeometry,
  type Gray,
  type ImageLike,
  type Line,
  type StripGeometry,
} from './profile';
import { skewness } from './signal';

export interface CountOptions {
  /** Half-width in pixels of the band averaged along the stripes. */
  bandHalfWidth?: number;
  /** Target number of periods per window. */
  periodsPerWindow?: number;
  /** Half-height of the straightened strip. */
  stripHalfHeight?: number;
}

export type Confidence = 'good' | 'check' | 'low';

export interface CountResult {
  /** The answer, or null when nothing countable was found. */
  count: number | null;
  /** Which method produced `count`. */
  method: 'period' | 'peaks' | 'none';
  periodCount: number | null;
  peakCount: number | null;
  confidence: Confidence;
  /** 0..1 from the period stage. */
  score: number;
  pxPerItem: number | null;
  /** Measured stripe tilt relative to the line's normal, degrees. */
  tiltDeg: number;
  /** Peak positions as strip columns (see StripGeometry). */
  ticks: number[];
  windows: PeriodWindow[];
  warnings: string[];
  geometry: StripGeometry;
}

/**
 * How far off a count of about `n` items may be: within 1 item up to 29,
 * then 5 percent (3 at 60, 20 at 400). Small stacks decide when to reorder,
 * so they need to be near exact; big stacks only need to be roughly right.
 * Used both for the accuracy gate and for "the two methods agree".
 */
export function countTolerance(n: number): number {
  return Math.max(1, Math.round(0.05 * n));
}

export const DEFAULTS = {
  bandHalfWidth: 6,
  periodsPerWindow: 25,
  stripHalfHeight: 32,
} as const;

/** Count from a full image and a line in its pixel coordinates (Node harness path). */
export function countStack(img: ImageLike, line: Line, opts: CountOptions = {}): CountResult {
  const geom = stripGeometry(line, opts.stripHalfHeight ?? DEFAULTS.stripHalfHeight);
  const strip = extractStrip(img, line, geom);
  return countStrip(strip, geom, opts);
}

/** Count from an already straightened strip (browser path: the canvas does the straightening). */
export function countStrip(strip: Gray, geom: StripGeometry, opts: CountOptions = {}): CountResult {
  const band = opts.bandHalfWidth ?? DEFAULTS.bandHalfWidth;
  const warnings: string[] = [];
  const empty = (msg: string): CountResult => ({
    count: null,
    method: 'none',
    periodCount: null,
    peakCount: null,
    confidence: 'low',
    score: 0,
    pxPerItem: null,
    tiltDeg: 0,
    ticks: [],
    windows: [],
    warnings: [msg],
    geometry: geom,
  });

  if (geom.length < 10) return empty('The line is too short. Tap the first item, then the last item.');

  const angle = estimateStripeAngle(strip, geom);
  if (angle.assumed) warnings.push('Could not measure the stripe direction; assumed square to the line.');
  const ext = geom.margin;
  const profile = sampleProfile(strip, geom, angle.angle, band, ext);

  const first = windowedPeriod(profile, ext, geom.length, {
    periodsPerWindow: opts.periodsPerWindow ?? DEFAULTS.periodsPerWindow,
  });
  if (!first) return empty('No regular stripe pattern found along the line.');

  // Count the narrow lines, whichever polarity they have. Thick items show
  // as broad bodies separated by narrow lines: usually the shadowed gap
  // between two items, sometimes a lit edge. On a broad body the brightest
  // point is wherever a label, a gloss highlight or noise puts it, so
  // counting body peaks adds or drops items. The narrow lines are the long
  // tail of the brightness distribution, which the sign of the skew picks.
  const edgeSign = skewness(first.detrended, ext, ext + geom.length) < 0 ? -1 : 1;
  const edges = edgeSign < 0 ? first.detrended.map((v) => -v) : first.detrended;
  const edgeCount = (p: PeriodResult) => countPeaks(edges, p.periodAt, ext, ext + geom.length);
  let per = first;
  let peaks = edgeCount(first);

  // A second line through the middle of every item (a stripe on the spine)
  // can lock both stages onto half an item, and they then agree on double
  // the count. When the tick heights alternate with parity and the edge
  // count at twice the period agrees, report that count. Either way the
  // answer is never "good": a stack whose every other item differs (items
  // laid alternately reversed) gives the same profile, and then the first
  // count was right. The warning names both.
  let halfSuspect = false;
  const half = halfPeriodEvidence(edges, peaks.ticks, per.periodAt);
  if (half.alternation !== 'no') {
    halfSuspect = true;
    const doubled = scalePeriod(first, 2);
    const doubledPeaks = edgeCount(doubled);
    const n = Math.round(doubled.count);
    const m = Math.max(1, Math.round(first.count));
    if (half.alternation === 'clear' && Math.abs(doubledPeaks.count - n) <= countTolerance(n)) {
      per = doubled;
      peaks = doubledPeaks;
      warnings.push(`Every other line differs: counted ${n}, taking each item to have a stripe through it. If every other item differs instead, it is ${m}.`);
    } else {
      warnings.push(`Every other line differs: counted ${m}, but if each item has a stripe through it, it is ${n}.`);
    }
  }
  const periodCount = Math.max(1, Math.round(per.count));
  const peakCount = peaks.count;
  const pxPerItem = per.meanPeriod;

  const tol = countTolerance(periodCount);
  const diff = Math.abs(periodCount - peakCount);
  let count = periodCount;
  let method: CountResult['method'] = 'period';
  let confidence: Confidence;

  // Below ~2 px per item the period stage locks onto twice the period; the
  // edge count then comes out near double, which is the tell.
  const ratio = peakCount / periodCount;
  const lockedOnDouble = pxPerItem < 6 && ratio > 1.7 && ratio < 2.3;
  if (pxPerItem < 2.5 || lockedOnDouble) {
    warnings.push('Too far away: items are under 2.5 pixels each. Move closer or photograph in sections.');
    confidence = 'low';
  } else if (diff <= tol) {
    confidence = per.score >= 0.6 ? 'good' : per.score >= 0.35 ? 'check' : 'low';
  } else {
    // An edge count under 2 is no answer (nothing found), however thick the items.
    if (pxPerItem > 8 && peakCount >= 2) {
      count = peakCount;
      method = 'peaks';
    }
    warnings.push(`The two methods disagree (${periodCount} by spacing, ${peakCount} by edges).`);
    confidence = diff <= 2 * tol && per.score >= 0.35 ? 'check' : 'low';
  }
  if (halfSuspect && confidence === 'good') confidence = 'check';
  if (per.strongShare < 0.5) warnings.push('Parts of the stack have no clear stripe pattern (blur, glare or shadow?).');
  if (per.spread > 0.05) warnings.push('Item spacing is uneven along the stack.');

  return {
    count,
    method,
    periodCount,
    peakCount,
    confidence,
    score: per.score,
    pxPerItem,
    tiltDeg: (angle.angle * 180) / Math.PI,
    // Profile index k sits at strip column margin - ext + k = k.
    ticks: peaks.ticks,
    windows: per.windows,
    warnings,
    geometry: geom,
  };
}
