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
