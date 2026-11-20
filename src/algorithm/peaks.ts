// Per-edge cross-check: count prominent stripe peaks. Exact on thick items,
// and its tick positions are what the result screen draws.

import { boxSmooth, parabolicOffset } from './signal';

export interface PeakResult {
  /** Items from the item centre at `from` to the one at `to`, by tick phase (see countPeaks). */
  count: number;
  /** Extra items implied by tick gaps of about two or more local periods (missed edges). */
  inferred: number;
  /** Sub-sample positions (profile indices) of the counted peaks, ascending. */
  ticks: number[];
}

export interface PeakOptions {
  /** Minimum prominence in units of the local RMS of the detrended profile. */
  k?: number;
}

/**
 * Count peaks of `d` (already detrended) whose position lies within half a
 * period of [from, to]. `periodAt` gives the local stripe period.
 *
 * Prominence is topographic but local: from the peak, walk outwards (at most
 * one local period) until a higher sample, and take the lowest point passed
 * on each side. Small noise bumps on a wide bright item therefore score low,
 * and only the top of each item scores its full height.
 */
export function countPeaks(
  d: Float32Array,
  periodAt: (index: number) => number,
  from: number,
  to: number,
  opts: PeakOptions = {},
): PeakResult {
  const k = opts.k ?? 0.6;
  const n = d.length;
  const midP = periodAt((from + to) / 2);
  const sq = new Float32Array(n);
  for (let i = 0; i < n; i++) sq[i] = d[i] * d[i];
  const ms = boxSmooth(sq, Math.max(3, Math.round(4 * midP)));

  const cands: { pos: number; prom: number }[] = [];
  for (let i = 1; i < n - 1; i++) {
    const v = d[i];
    if (!(v > d[i - 1] && v >= d[i + 1])) continue;
    const h = Math.max(2, Math.round(periodAt(i)));
    let lmin = v;
    for (let j = i - 1; j >= Math.max(0, i - h); j--) {
      if (d[j] >= v) break;
      if (d[j] < lmin) lmin = d[j];
    }
    let rmin = v;
    for (let j = i + 1; j <= Math.min(n - 1, i + h); j++) {
      if (d[j] > v) break;
      if (d[j] < rmin) rmin = d[j];
    }
    const prom = v - Math.max(lmin, rmin);
    if (prom < k * Math.sqrt(ms[i])) continue;
    cands.push({ pos: i + parabolicOffset(d[i - 1], v, d[i + 1]), prom });
  }

  const inPhase = keepInPhase(cands, periodAt, n);

  // Minimum spacing of half a local period, most prominent first.
  const sorted = inPhase.sort((a, b) => b.prom - a.prom);
  const kept: number[] = []; // ascending positions
  const insertAt = (x: number): number => {
    let lo = 0;
    let hi = kept.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (kept[mid] < x) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  for (const c of sorted) {
    const minSep = 0.5 * periodAt(c.pos);
    const at = insertAt(c.pos);
    if (at > 0 && c.pos - kept[at - 1] < minSep) continue;
    if (at < kept.length && kept[at] - c.pos < minSep) continue;
    kept.splice(at, 0, c.pos);
  }

  const lo = from - 0.5 * periodAt(from);
  const hi = to + 0.5 * periodAt(to);
  const ticks = kept.filter((p) => p >= lo && p < hi);

  // Count by phase, not by ticks in a window. Each tick advances the phase by
  // one item, or by round(gap / period) items when a missing or stuck-together
  // edge leaves a gap of about two periods. The endpoints are item centres,
  // so the count is phase(to) - phase(from) + 1. On thick items the ticks are
  // often the gaps between items rather than item centres; a tick-in-window
  // count then hinges on whether the outer gaps fall just inside or outside
  // the window, while the phase count is the same for either.
  if (kept.length < 2) return { count: ticks.length, ticks, inferred: 0 };
  const phase = new Float64Array(kept.length);
  let inferred = 0;
  for (let i = 1; i < kept.length; i++) {
    const steps = Math.max(1, Math.round((kept[i] - kept[i - 1]) / periodAt((kept[i] + kept[i - 1]) / 2)));
    phase[i] = phase[i - 1] + steps;
    if (kept[i - 1] >= lo && kept[i] < hi) inferred += steps - 1;
  }
  const last = kept.length - 1;
  const phaseAt = (x: number): number => {
    if (x <= kept[0]) return -(kept[0] - x) / periodAt((x + kept[0]) / 2);
    if (x >= kept[last]) return phase[last] + (x - kept[last]) / periodAt((x + kept[last]) / 2);
    let j = 0;
    while (kept[j + 1] < x) j++;
    return phase[j] + ((phase[j + 1] - phase[j]) * (x - kept[j])) / (kept[j + 1] - kept[j]);
  };
  const count = Math.max(1, Math.round(phaseAt(to) - phaseAt(from) + 1));
  return { count, ticks, inferred };
}

/**
 * Drop candidates out of step with their neighbours. Every item in a stack
 * is the same title and thickness, so the lines between items sit at one
 * phase of the local period. Staggered stacks (groups of about ten items
 * spine-out, then about ten pages-out) also show fine sheet lines inside
 * the pages-out items, as prominent as the weakened gap lines there; their
 * phase is random. A candidate is kept when its phase is within PHASE_TOL
 * periods of the prominence-weighted mean phase of the other candidates
 * within PHASE_REACH items, or when those have no common phase.
 *
 * The same filter drops labels, gloss and sticky notes inside thick items
 * (6811, 6814 with the line shifted sideways used to count 25-26 of 23).
 * It uses the period stage's phase, so a period that is off by p percent
 * drifts PHASE_REACH * p percent of a period across the reach: the reach
 * is kept short so the edge count stays a check on the period.
 */
const PHASE_REACH = 3;
const PHASE_TOL = 0.2;
/** Resultant length over total weight below which the neighbours have no common phase. */
const PHASE_COHERENCE = 0.1;

function keepInPhase<C extends { pos: number; prom: number }>(cands: C[], periodAt: (index: number) => number, n: number): C[] {
  if (cands.length < 3) return cands;
  // Item phase along the profile: u[i] = integral of 1/period up to index i.
  const u = new Float64Array(n);
  for (let i = 1; i < n; i++) u[i] = u[i - 1] + 1 / periodAt(i - 0.5);
  const phaseAt = (x: number): number => {
    const i = Math.max(0, Math.min(n - 2, Math.floor(x)));
    return u[i] + (x - i) * (u[i + 1] - u[i]);
  };
  const ph = cands.map((c) => phaseAt(c.pos));
  const byPos = cands.map((_, i) => i).sort((a, b) => ph[a] - ph[b]);
  const out: C[] = [];
  let lo = 0;
  let hi = 0;
  for (const i of byPos) {
    while (ph[byPos[lo]] < ph[i] - PHASE_REACH) lo++;
    while (hi < byPos.length && ph[byPos[hi]] <= ph[i] + PHASE_REACH) hi++;
    let re = 0;
    let im = 0;
    let w = 0;
    for (let t = lo; t < hi; t++) {
      const j = byPos[t];
      if (j === i) continue;
      const a = 2 * Math.PI * (ph[j] - ph[i]);
      re += cands[j].prom * Math.cos(a);
      im += cands[j].prom * Math.sin(a);
      w += cands[j].prom;
    }
    // Angles are relative to this candidate, so the mean phase is within
    // PHASE_TOL periods of it when the resultant's cosine exceeds cos(2 pi PHASE_TOL).
    const len = Math.hypot(re, im);
    const coherent = w > 0 && len >= PHASE_COHERENCE * w;
    if (!coherent || re >= Math.cos(2 * Math.PI * PHASE_TOL) * len) out.push(cands[i]);
  }
  return out;
}

export interface HalfPeriodEvidence {
  /**
   * 'clear': tick heights alternate with phase parity beyond doubt, so
   * there are two kinds of line of different depth. 'maybe': weaker
   * alternation, or one parity's heights vary much more than the other's
   * (two kinds of line of similar depth). 'no': neither.
   */
  alternation: 'no' | 'maybe' | 'clear';
  /** |t| of the parity-signed height difference of adjacent ticks, and the number of pairs. */
  heightT: number;
  pairs: number;
  /** Larger over smaller height variance of the two parities (>= 1), and the smaller sample. */
  varianceRatio: number;
  perParity: number;
}

/**
 * Evidence that the ticks alternate between two kinds of line, i.e. that
 * the period is probably half the item thickness.
 *
 * When every item shows a second line near its middle (a printed stripe
 * along the spine, the seam of a two-tone spine), the period stage can lock
 * onto half an item, and the ticks then fall on gaps and mid-item lines in
 * turn. Both counts come out double and agree, so nothing else catches it.
 * Ticks are split by phase parity: even or odd numbers of periods from the
 * first tick (a gap of two periods, a missed tick, keeps the parity).
 *
 * - Heights: the two kinds of line rarely have the same depth. Adjacent
 *   ticks are paired without overlap, the height difference signed by the
 *   pair's parity (so a slow brightness drift cancels), and its mean tested
 *   against zero. 'clear' needs |t| >= 4 + 12 / (pairs - 1) and 5 pairs;
 *   'maybe' needs |t| >= 2.5 and 4 pairs. Unlocked synthetic stacks reach
 *   |t| = 3.7 (14 ticks), the real photos with shifted lines and other band
 *   widths 1.5. A stripe up to 0.7 of the gap depth usually gives 6 to 35.
 * - Variance ('maybe' only): when the depths match on average, a printed
 *   stripe is still more uniform than shadowed gaps. Same-parity second
 *   differences (again drift-free) give each parity's height variance, and
 *   their ratio must reach 10 with 4 per parity. Unlocked synthetic stacks
 *   reach 20 with 5 per parity (small samples scatter widely), the real
 *   photos 4.9. An equal-depth stripe on 20 or more items gives 34 to 800.
 *
 * 'maybe' only costs a "check" on a right count; 'clear' changes the count,
 * so it must not fire on unlocked stacks (none of 228 synthetic, none of
 * the 90 real-photo variants). Stacks of about five items or fewer have too
 * few ticks for either test.
 * `d` is the profile the ticks were found on, with the counted lines positive.
 */
export function halfPeriodEvidence(d: Float32Array, ticks: number[], periodAt: (index: number) => number): HalfPeriodEvidence {
  const n = ticks.length;
  const h = ticks.map((x) => d[Math.round(x)]);
  // steps[i]: periods from tick i-1 to tick i; parity[i]: phase parity of tick i.
  const steps = new Array<number>(n).fill(0);
  const parity = new Array<number>(n).fill(0);
  for (let i = 1; i < n; i++) {
    steps[i] = Math.max(1, Math.round((ticks[i] - ticks[i - 1]) / periodAt((ticks[i] + ticks[i - 1]) / 2)));
    parity[i] = (parity[i - 1] + steps[i]) % 2;
  }

  const diffs: number[] = [];
  for (let i = 1; i < n; i++) {
    if (steps[i] !== 1) continue;
    diffs.push(parity[i - 1] ? h[i] - h[i - 1] : h[i - 1] - h[i]);
    i++; // tick i is used; the next pair starts after it
  }
  const pairs = diffs.length;
  let heightT = 0;
  if (pairs >= 2) {
    const mean = diffs.reduce((a, b) => a + b, 0) / pairs;
    const sd = Math.sqrt(diffs.reduce((a, b) => a + (b - mean) ** 2, 0) / (pairs - 1));
    heightT = sd > 0 ? Math.abs(mean) / (sd / Math.sqrt(pairs)) : 0;
  }

  const ss = [0, 0];
  const cnt = [0, 0];
  for (let i = 2; i + 2 < n; i++) {
    if (steps[i - 1] !== 1 || steps[i] !== 1 || steps[i + 1] !== 1 || steps[i + 2] !== 1) continue;
    const c = h[i] - 0.5 * (h[i - 2] + h[i + 2]);
    ss[parity[i]] += c * c;
    cnt[parity[i]]++;
  }
  const perParity = Math.min(cnt[0], cnt[1]);
  let varianceRatio = 1;
  if (perParity > 0) {
    const a = ss[0] / cnt[0];
    const b = ss[1] / cnt[1];
    varianceRatio = Math.max(a, b) / Math.max(1e-9, Math.min(a, b));
  }

  const clear = pairs >= 5 && heightT >= 4 + 12 / (pairs - 1);
  const maybe = (pairs >= 4 && heightT >= 2.5) || (perParity >= 4 && varianceRatio >= 10);
  return {
    alternation: clear ? 'clear' : maybe ? 'maybe' : 'no',
    heightT,
    pairs,
    varianceRatio,
    perParity,
  };
}
