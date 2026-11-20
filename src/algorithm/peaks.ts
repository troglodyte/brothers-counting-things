// Per-edge cross-check: count prominent stripe peaks. Exact on thick items,
// and its tick positions are what the result screen draws.

import { boxSmooth, parabolicOffset } from './signal';

export interface PeakResult {
  /** Peaks inside the counted range. */
  count: number;
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
  return { count: ticks.length, ticks };
}
