// Small 1-D signal helpers shared by the period and peak stages.

/** Centered moving average with window `w` (edges average over what exists). */
export function boxSmooth(x: Float32Array, w: number): Float32Array {
  const n = x.length;
  const out = new Float32Array(n);
  if (w <= 1 || n === 0) {
    out.set(x);
    return out;
  }
  const prefix = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + x[i];
  const left = Math.floor((w - 1) / 2);
  const right = w - 1 - left;
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - left);
    const b = Math.min(n - 1, i + right);
    out[i] = (prefix[b + 1] - prefix[a]) / (b - a + 1);
  }
  return out;
}

/**
 * Remove the slow trend (lighting, perspective brightness) from a periodic
 * signal. A box filter one period long applied twice has nulls at the
 * fundamental and all harmonics, so the trend estimate is nearly free of the
 * stripes themselves.
 */
export function detrend(x: Float32Array, period: number): Float32Array {
  const w = Math.max(2, Math.round(period));
  const trend = boxSmooth(boxSmooth(x, w), w);
  const out = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) out[i] = x[i] - trend[i];
  return out;
}

/** Gaussian smoothing, kernel truncated at 3 sigma, edges clamped. */
export function gaussianSmooth(x: Float32Array, sigma: number): Float32Array {
  const n = x.length;
  if (sigma <= 0 || n === 0) return Float32Array.from(x);
  const r = Math.max(1, Math.ceil(3 * sigma));
  const k = new Float64Array(2 * r + 1);
  let sum = 0;
  for (let i = -r; i <= r; i++) {
    const v = Math.exp(-(i * i) / (2 * sigma * sigma));
    k[i + r] = v;
    sum += v;
  }
  for (let i = 0; i < k.length; i++) k[i] /= sum;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let acc = 0;
    for (let j = -r; j <= r; j++) {
      let idx = i + j;
      if (idx < 0) idx = 0;
      else if (idx >= n) idx = n - 1;
      acc += x[idx] * k[j + r];
    }
    out[i] = acc;
  }
  return out;
}

/**
 * Normalized autocorrelation of x[start, end) for lags in [minLag, maxLag].
 * Each lag is normalized by the energy of its own overlapping parts, so the
 * value is a correlation coefficient in [-1, 1] that does not shrink with lag.
 * Entries outside [minLag, maxLag] are NaN.
 */
export function autocorr(
  x: Float32Array,
  start: number,
  end: number,
  minLag: number,
  maxLag: number,
): Float64Array {
  const r = new Float64Array(Math.max(0, maxLag) + 1).fill(NaN);
  for (let lag = Math.max(0, minLag); lag <= maxLag; lag++) {
    let s = 0;
    let e0 = 0;
    let e1 = 0;
    for (let i = start; i + lag < end; i++) {
      const a = x[i];
      const b = x[i + lag];
      s += a * b;
      e0 += a * a;
      e1 += b * b;
    }
    const den = Math.sqrt(e0 * e1);
    r[lag] = den > 0 ? s / den : 0;
  }
  return r;
}

/** Sub-sample offset of a parabola's vertex through three equally spaced samples. */
export function parabolicOffset(ym: number, y0: number, yp: number): number {
  const d = ym - 2 * y0 + yp;
  if (!(d < 0)) return 0;
  const o = (0.5 * (ym - yp)) / d;
  return Math.max(-0.5, Math.min(0.5, o));
}

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export function median(values: number[]): number {
  if (values.length === 0) return NaN;
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : 0.5 * (s[m - 1] + s[m]);
}
