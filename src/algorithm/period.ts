// Windowed period estimation: the count is the line length divided by the
// local stripe period, integrated along the line so perspective (items near
// the camera look thicker) is handled.

import { autocorr, boxSmooth, clamp01, detrend, parabolicOffset } from './signal';

export interface GlobalPeriod {
  period: number;
  strength: number;
}

export interface PeriodWindow {
  start: number;
  end: number;
  center: number;
  /** Period used for counting (interpolated from neighbours for weak windows). */
  period: number;
  /** Period this window measured itself, NaN if none. */
  measured: number;
  /** Autocorrelation at the chosen lag. */
  strength: number;
  strong: boolean;
}

export interface PeriodResult {
  globalPeriod: number;
  globalStrength: number;
  /** Profile with the slow trend removed (same indexing as the input). */
  detrended: Float32Array;
  windows: PeriodWindow[];
  /** Items between the endpoints, inclusive of both endpoint items (unrounded). */
  count: number;
  meanPeriod: number;
  strongShare: number;
  /** Relative scatter of strong-window periods around a linear perspective trend. */
  spread: number;
  /** 0..1 confidence from strongShare and spread. */
  score: number;
  periodAt: (index: number) => number;
}

export interface PeriodOptions {
  /** Longest window, in periods. Short lines use shorter windows (a third of the line, at least 4 periods). */
  periodsPerWindow?: number;
  strongThreshold?: number;
}

function localMaxima(r: Float64Array, lo: number, hi: number, minValue: number): number[] {
  const out: number[] = [];
  for (let l = Math.max(1, lo); l <= Math.min(hi, r.length - 2); l++) {
    const v = r[l];
    if (v > minValue && v > r[l - 1] && v >= r[l + 1]) out.push(l);
  }
  return out;
}

/**
 * Coarse period of profile[start, end) from whole-segment autocorrelation.
 * Picks the smallest lag whose autocorrelation peak is close to the best one,
 * which avoids reporting a multiple of the true period.
 */
export function estimateGlobalPeriod(profile: Float32Array, start: number, end: number): GlobalPeriod | null {
  const n = end - start;
  if (n < 8) return null;

  // Rough trend removal with a window that is long compared to any plausible period.
  const seg = profile.subarray(start, end);
  const wide = Math.max(15, Math.round(n / 6));
  const trend = boxSmooth(boxSmooth(seg, wide), wide);
  const rough = new Float32Array(n);
  for (let i = 0; i < n; i++) rough[i] = seg[i] - trend[i];

  const maxLag = Math.max(4, Math.floor(n / 3));
  const r = autocorr(rough, 0, n, 1, maxLag + 1);
  const peaks = localMaxima(r, 2, maxLag, 0.1);
  if (peaks.length === 0) return null;
  let best = -Infinity;
  for (const l of peaks) best = Math.max(best, r[l]);
  const first = peaks.find((l) => r[l] >= 0.6 * best)!;

  // Refine around the coarse lag with a proper one-period detrend.
  const fine = detrend(seg, first);
  const lo = Math.max(2, Math.floor(0.7 * first));
  const hi = Math.min(Math.ceil(1.4 * first), Math.floor(n / 2));
  if (hi <= lo) return { period: first, strength: r[first] };
  const rf = autocorr(fine, 0, n, lo - 1, hi + 1);
  let bl = lo;
  for (let l = lo; l <= hi; l++) if (rf[l] > rf[bl]) bl = l;
  const period = bl + parabolicOffset(rf[bl - 1], rf[bl], rf[bl + 1]);
  return { period, strength: rf[bl] };
}

/**
 * Count items over profile[coreStart, coreStart + coreLength] (a real-valued
 * length in samples). The endpoints are the centres of the first and last
 * item, so the count is (integral of 1/period) + 1.
 */
export function windowedPeriod(
  profile: Float32Array,
  coreStart: number,
  coreLength: number,
  opts: PeriodOptions = {},
): PeriodResult | null {
  const coreEnd = Math.min(profile.length, coreStart + Math.floor(coreLength) + 1);
  const g = coarsePeriod(profile, coreStart, coreEnd);
  if (!g || !(g.period >= 1.5)) return null;
  return measureWindows(profile, coreStart, coreLength, g, opts);
}

/**
 * Coarse period of profile[start, end): estimated on the whole segment, on
 * its halves and on its thirds, then the smallest of those whose
 * autocorrelation is close to the strongest. That is the rule
 * estimateGlobalPeriod applies to lags, applied to pieces of the line.
 *
 * Perspective changes the item spacing along a stack (by 35 percent on one
 * book photo). On thick items the stripes are narrow gap lines, and over the
 * whole line their autocorrelation then has no clear peak at any one
 * spacing: it can peak at two or four items, or at a chance coincidence.
 * A third of the line sees a nearly constant spacing and a clear peak. The
 * smallest such period is the one from the end where items look thinnest;
 * the windows then search up to 1.5 times it.
 */
export function coarsePeriod(profile: Float32Array, start: number, end: number): GlobalPeriod | null {
  const n = end - start;
  const found: GlobalPeriod[] = [];
  for (const parts of [1, 2, 3]) {
    for (let i = 0; i < parts; i++) {
      const g = estimateGlobalPeriod(profile, start + Math.round((i * n) / parts), start + Math.round(((i + 1) * n) / parts));
      if (g && g.period >= 1.5) found.push(g);
    }
  }
  if (found.length === 0) return null;
  const best = Math.max(...found.map((g) => g.strength));
  let pick: GlobalPeriod | null = null;
  for (const g of found) if (g.strength >= 0.6 * best && (!pick || g.period < pick.period)) pick = g;
  return pick;
}

/** Largest relative change the multiple-lag refinement may make (it corrects a 1-2 percent bias). */
const REFINE_AGREE = 0.03;

function measureWindows(
  profile: Float32Array,
  coreStart: number,
  coreLength: number,
  g: GlobalPeriod,
  opts: PeriodOptions,
): PeriodResult {
  const periodsPerWindow = opts.periodsPerWindow ?? 25;
  const strongThreshold = opts.strongThreshold ?? 0.35;
  const coreEnd = Math.min(profile.length, coreStart + Math.floor(coreLength) + 1);
  const n = coreEnd - coreStart;
  const P0 = g.period;
  const detrended = detrend(profile, P0);

  // Windows are at most `periodsPerWindow` periods long, but also at most a
  // third of the line, so a short stack still gets about five overlapping
  // windows. Perspective changes the item spacing along the stack (153 to
  // 109 px down one 23-book photo), and a single window's autocorrelation
  // then reports the most common spacing, not the mean, so the count is off
  // by several items. Never shorter than 4 periods.
  let W = Math.max(Math.min(Math.round(periodsPerWindow * P0), Math.round(n / 3)), Math.round(4 * P0));
  if (W >= n) W = n;
  const k = W >= n ? 1 : Math.ceil((n - W) / (W / 2)) + 1;

  const windows: PeriodWindow[] = [];
  for (let i = 0; i < k; i++) {
    const s = coreStart + (k === 1 ? 0 : Math.round((i * (n - W)) / (k - 1)));
    const e = s + W;
    const minLag = Math.max(2, Math.floor(0.6 * P0));
    const maxLag = Math.max(minLag + 1, Math.min(Math.ceil(1.5 * P0), Math.floor(W / 2)));
    const r = autocorr(detrended, s, e, minLag - 1, maxLag + 1);
    let bl = minLag;
    for (let l = minLag; l <= maxLag; l++) if (r[l] > r[bl]) bl = l;
    const interior = r[bl] > r[bl - 1] && r[bl] >= r[bl + 1];
    let measured = bl + parabolicOffset(r[bl - 1], r[bl], r[bl + 1]);
    const strength = r[bl];
    const strong = interior && strength >= strongThreshold;
    // A parabola through integer lags around a peak only a few samples wide
    // is biased toward the integer lag (1-2 percent at 3-4 px per item).
    // Refining at the m-th multiple of the period divides that bias by m.
    // The refined period must stay within REFINE_AGREE of the first one: in
    // a staggered stack whose gap lines change polarity every ~10 items, the
    // m-th multiple spans a flip and its peak can sit half a period off
    // (6 percent long at m = 8 on a synthetic 80-item stack).
    if (strong) {
      const m = Math.max(1, Math.floor(W / (3 * measured)));
      if (m > 1) {
        const lo = Math.max(2, Math.round(m * measured - 0.5 * measured));
        const hi = Math.min(W - 2, Math.round(m * measured + 0.5 * measured));
        if (hi > lo) {
          const rm = autocorr(detrended, s, e, lo - 1, hi + 1);
          let bm = lo;
          for (let l = lo; l <= hi; l++) if (rm[l] > rm[bm]) bm = l;
          const ok = rm[bm] > rm[bm - 1] && rm[bm] >= rm[bm + 1] && rm[bm] >= strongThreshold;
          const refined = (bm + parabolicOffset(rm[bm - 1], rm[bm], rm[bm + 1])) / m;
          if (ok && Math.abs(refined - measured) <= REFINE_AGREE * measured) measured = refined;
        }
      }
    }
    windows.push({
      start: s,
      end: e,
      center: (s + e - 1) / 2,
      period: strong ? measured : NaN,
      measured: interior ? measured : NaN,
      strength,
      strong,
    });
  }

  // Weak windows borrow the period of their strong neighbours.
  const strongIdx = windows.map((w, i) => (w.strong ? i : -1)).filter((i) => i >= 0);
  for (let i = 0; i < windows.length; i++) {
    const w = windows[i];
    if (w.strong) continue;
    let left = -1;
    let right = -1;
    for (const j of strongIdx) {
      if (j < i) left = j;
      else if (j > i && right < 0) right = j;
    }
    if (left >= 0 && right >= 0) {
      const a = windows[left];
      const b = windows[right];
      const t = (w.center - a.center) / (b.center - a.center);
      w.period = a.period + t * (b.period - a.period);
    } else if (left >= 0) w.period = windows[left].period;
    else if (right >= 0) w.period = windows[right].period;
    else w.period = P0;
  }

  const centers = windows.map((w) => w.center);
  const periods = windows.map((w) => w.period);
  const periodAt = (x: number): number => {
    if (windows.length === 1 || x <= centers[0]) return periods[0];
    const last = windows.length - 1;
    if (x >= centers[last]) return periods[last];
    let j = 0;
    while (j < last - 1 && centers[j + 1] < x) j++;
    const t = (x - centers[j]) / (centers[j + 1] - centers[j]);
    return periods[j] + t * (periods[j + 1] - periods[j]);
  };

  let acc = 0;
  for (let x = 0; x < coreLength; x += 1) {
    const dx = Math.min(1, coreLength - x);
    acc += dx / periodAt(coreStart + x + dx / 2);
  }
  const count = acc + 1;

  // Confidence: share of windows that measured a clear period, and how much
  // those periods scatter around a straight-line (perspective) trend.
  const strong = windows.filter((w) => w.strong);
  const strongShare = strong.length / windows.length;
  let spread = 0;
  if (strong.length >= 2) {
    const xs = strong.map((w) => w.center);
    const ys = strong.map((w) => w.period);
    const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
    const my = ys.reduce((a, b) => a + b, 0) / ys.length;
    let sxy = 0;
    let sxx = 0;
    for (let i = 0; i < xs.length; i++) {
      sxy += (xs[i] - mx) * (ys[i] - my);
      sxx += (xs[i] - mx) ** 2;
    }
    const slope = strong.length >= 3 && sxx > 0 ? sxy / sxx : 0;
    let ss = 0;
    for (let i = 0; i < xs.length; i++) ss += (ys[i] - my - slope * (xs[i] - mx)) ** 2;
    const dof = Math.max(1, xs.length - (strong.length >= 3 ? 2 : 1));
    spread = Math.sqrt(ss / dof) / my;
  }
  const score = strongShare * clamp01(1 - spread / 0.05);
  const meanPeriod = coreLength > 0 ? coreLength / Math.max(1e-9, acc) : P0;

  return {
    globalPeriod: P0,
    globalStrength: g.strength,
    detrended,
    windows,
    count,
    meanPeriod,
    strongShare,
    spread,
    score,
    periodAt,
  };
}
