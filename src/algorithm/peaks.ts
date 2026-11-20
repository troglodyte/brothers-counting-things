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

  // Minimum spacing of half a local period, most prominent first.
  cands.sort((a, b) => b.prom - a.prom);
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
  for (const c of cands) {
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
