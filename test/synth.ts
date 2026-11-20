// Synthetic stacks with a known count, used by the unit tests and by the
// public synthetic harness set. Deterministic for a given seed.

import type { Line } from '../src/algorithm/profile';

export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function gauss(rand: () => number): number {
  const u = Math.max(1e-12, rand());
  const v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Boundaries between items along the stack for `count` items, with linear perspective. */
function boundaries(count: number, pxPerItem: number, perspective: number, jitter: number, rand: () => number): Float64Array {
  const b = new Float64Array(count + 1);
  for (let k = 0; k < count; k++) {
    const rel = count > 1 ? k / (count - 1) - 0.5 : 0;
    const t = pxPerItem * (1 + perspective * rel) * (1 + jitter * gauss(rand));
    b[k + 1] = b[k] + Math.max(0.5, t);
  }
  return b;
}

/** Distance from s to the nearest boundary, and the item index containing s. */
function locate(b: Float64Array, s: number): { k: number; delta: number; boundary: number } {
  let lo = 0;
  let hi = b.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (b[mid] <= s) lo = mid;
    else hi = mid;
  }
  const dl = s - b[lo];
  const dh = b[hi] - s;
  return dl < dh ? { k: lo, delta: dl, boundary: lo } : { k: lo, delta: dh, boundary: hi };
}

export interface ProfileOptions {
  count: number;
  period: number;
  ext?: number;
  noise?: number;
  gradient?: number;
  missingEdgeRate?: number;
  perspective?: number;
  seed?: number;
}

/**
 * A 1-D profile like the one sampleProfile produces: bright items, dark gaps,
 * item 0's centre at index `ext`, item count-1's centre at ext + coreLength.
 */
export function synthProfile(o: ProfileOptions): { profile: Float32Array; ext: number; coreLength: number } {
  const rand = rng(o.seed ?? 1);
  const ext = o.ext ?? Math.ceil(2 * o.period);
  const b = boundaries(o.count, o.period, o.perspective ?? 0, 0, rand);
  const c0 = (b[0] + b[1]) / 2;
  const cN = (b[o.count - 1] + b[o.count]) / 2;
  const coreLength = cN - c0;
  const n = Math.floor(coreLength + 2 * ext) + 1;
  const depth = new Float64Array(o.count + 1);
  for (let i = 0; i <= o.count; i++) depth[i] = rand() < (o.missingEdgeRate ?? 0) ? 6 : 60 * (0.8 + 0.4 * rand());
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const s = c0 + (i - ext);
    let v: number;
    if (s < b[0] || s > b[o.count]) v = 40;
    else {
      const { delta, boundary } = locate(b, s);
      const w = Math.max(0.6, 0.22 * o.period);
      v = 170 - depth[boundary] * Math.exp(-((delta / w) ** 2));
    }
    v += (o.gradient ?? 0) * (i / n - 0.5);
    v += (o.noise ?? 0) * gauss(rand);
    out[i] = v;
  }
  return { profile: out, ext, coreLength };
}

export interface StackImageOptions {
  count: number;
  pxPerItem: number;
  /** Width of the image (the stack fills the middle 80 percent). */
  width?: number;
  /** Relative thickness change bottom to top, e.g. 0.1. */
  perspective?: number;
  /** Per-item thickness jitter (relative std). */
  jitter?: number;
  tiltDeg?: number;
  /** Gaussian noise std in grey levels. */
  noise?: number;
  /** Multiplicative lighting gradient across the image, e.g. 0.3. */
  gradient?: number;
  missingEdgeRate?: number;
  /**
   * Brightness of one narrow bright band inside each item, at a random
   * place in its middle half: a gold spine label or a gloss highlight.
   */
  highlight?: number;
  /** Share of items that have the highlight (default 1). */
  highlightRate?: number;
  /**
   * Width of the dark gap between items, px (default 0.2 px per item). Book
   * stacks have gaps of 5 to 10 percent of an item: a narrow shadow line.
   */
  edgeWidthPx?: number;
  /**
   * Depth (grey levels) of a second dark line through the middle of every
   * item, as wide as the gap lines: a printed stripe along the spine, or the
   * seam of a two-tone spine. It halves the apparent period.
   */
  midLine?: number;
  /** The line's two ends are offset sideways by +-skew px (a crooked tap). */
  lineSkewPx?: number;
  /** Background rows above and below the stack. */
  marginPx?: number;
  /** Alternating groups of spine-out and pages-out items (see StaggerOptions). */
  stagger?: StaggerOptions;
  seed?: number;
}

/**
 * A staggered stack of one title: groups of about `groupSize` items show
 * their folded spines, the next group their page edges, and so on. Modelled
 * on real photos 6815/6816: the page groups are darker, their gap lines are
 * weaker, and fine sheet lines run inside each item; where one group
 * overhangs the next there is a deeper shadow line.
 */
export interface StaggerOptions {
  /** Mean items per group (each group varies by up to +-2). Default 10. */
  groupSize?: number;
  /** Body brightness change of page items, grey levels. Default -40. */
  pageShift?: number;
  /**
   * Gap depth of page items relative to spine items. Default 0.5 (weaker
   * dark gaps); negative gives bright gap lines (flipped polarity).
   */
  pageGap?: number;
  /** Fine dark sheet lines inside each page item. Default 0. */
  pageLines?: number;
  /** Depth of each sheet line, grey levels. Default 30. */
  pageLineDepth?: number;
  /** Gap depth at a group boundary relative to a spine gap. Default 1.5. */
  groupShadow?: number;
}

export interface StackImage {
  width: number;
  height: number;
  data: Uint8ClampedArray;
  channels: 1;
  line: Line;
  trueCount: number;
}

/** A side-on photo of a squared stack: horizontal stripes, line from the bottom item to the top item. */
export function synthStack(o: StackImageOptions): StackImage {
  const rand = rng(o.seed ?? 7);
  const N = o.count;
  const b = boundaries(N, o.pxPerItem, o.perspective ?? 0, o.jitter ?? 0, rand);
  const T = b[N];
  const margin = o.marginPx ?? Math.max(40, Math.round(4 * o.pxPerItem));
  const W = o.width ?? 240;
  const H = Math.ceil(T + 2 * margin);
  const tilt = ((o.tiltDeg ?? 0) * Math.PI) / 180;
  const cos = Math.cos(tilt);
  const sin = Math.sin(tilt);
  const cx = W / 2;
  const cy = H / 2;

  const base = new Float64Array(N);
  for (let k = 0; k < N; k++) base[k] = 175 + 18 * gauss(rand);
  const depth = new Float64Array(N + 1);
  for (let i = 0; i <= N; i++) depth[i] = rand() < (o.missingEdgeRate ?? 0) ? 8 : 85 * (0.75 + 0.5 * rand());
  const edgeW = o.edgeWidthPx ?? Math.max(0.45, 0.2 * o.pxPerItem);
  const highlight = o.highlight ?? 0;
  const glint = new Float64Array(N).fill(NaN);
  // Drawn only when used, so existing seeds give the same images.
  if (highlight) {
    for (let k = 0; k < N; k++) {
      const at = b[k] + (b[k + 1] - b[k]) * (0.25 + 0.5 * rand());
      if (rand() < (o.highlightRate ?? 1)) glint[k] = at;
    }
  }
  const midLine = o.midLine ?? 0;
  const glintW = Math.max(1, 0.06 * o.pxPerItem);
  // Stagger draws from its own generator, so existing seeds give the same images.
  const sheets: number[][] = Array.from({ length: N }, () => []);
  const sheetW = 0.7;
  let sheetDepth = 0;
  if (o.stagger) {
    const st = o.stagger;
    const srand = rng((o.seed ?? 7) * 7919 + 17);
    const page = new Array<boolean>(N);
    let isPage = srand() < 0.5;
    for (let k = 0; k < N; ) {
      const size = Math.max(1, Math.round((st.groupSize ?? 10) + 4 * srand() - 2));
      for (let j = 0; j < size && k < N; j++, k++) page[k] = isPage;
      isPage = !isPage;
    }
    sheetDepth = st.pageLineDepth ?? 30;
    for (let k = 0; k < N; k++) {
      if (!page[k]) continue;
      base[k] += st.pageShift ?? -40;
      for (let j = 0; j < (st.pageLines ?? 0); j++) sheets[k].push(b[k] + (b[k + 1] - b[k]) * (0.15 + 0.7 * srand()));
    }
    // Boundary i lies between items i-1 and i; the stack's outer edges keep their gap.
    for (let i = 1; i < N; i++) {
      if (page[i - 1] !== page[i]) depth[i] *= st.groupShadow ?? 1.5;
      else if (page[i]) depth[i] *= st.pageGap ?? 0.5;
    }
  }
  const gradient = o.gradient ?? 0;
  const noise = o.noise ?? 0;

  // Stack frame: a = across (x), s = up the stack from its bottom.
  const shade = (x: number, y: number): number => {
    const xr = cos * (x - cx) + sin * (y - cy) + cx;
    const yr = -sin * (x - cx) + cos * (y - cy) + cy;
    const s = cy + T / 2 - yr;
    const a = xr;
    const light = 1 + gradient * (a / W - 0.5) + 0.5 * gradient * (s / T - 0.5);
    if (s < 0 || s > T || a < 0.1 * W || a > 0.9 * W) return 35 * light;
    const { k, delta, boundary } = locate(b, s);
    const kk = Math.min(N - 1, k);
    let shine = glint[kk] >= 0 ? highlight * Math.exp(-(((s - glint[kk]) / glintW) ** 2)) : 0;
    if (midLine) shine -= midLine * Math.exp(-(((s - 0.5 * (b[kk] + b[kk + 1])) / edgeW) ** 2));
    for (const at of sheets[kk]) shine -= sheetDepth * Math.exp(-(((s - at) / sheetW) ** 2));
    return (base[kk] + shine - depth[boundary] * Math.exp(-((delta / edgeW) ** 2))) * light;
  };

  const data = new Uint8ClampedArray(W * H);
  const ss = 3;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let acc = 0;
      for (let j = 0; j < ss; j++) for (let i = 0; i < ss; i++) acc += shade(x + (i + 0.5) / ss - 0.5, y + (j + 0.5) / ss - 0.5);
      data[y * W + x] = acc / (ss * ss) + noise * gauss(rand);
    }
  }

  // Line from the centre of item 0 to the centre of item N-1, mapped back to image coordinates.
  const toImage = (a: number, s: number) => {
    const xr = a;
    const yr = cy + T / 2 - s;
    return {
      x: cos * (xr - cx) - sin * (yr - cy) + cx,
      y: sin * (xr - cx) + cos * (yr - cy) + cy,
    };
  };
  const skew = o.lineSkewPx ?? 0;
  const p1 = toImage(cx - skew, (b[0] + b[1]) / 2);
  const p2 = toImage(cx + skew, (b[N - 1] + b[N]) / 2);
  return { width: W, height: H, data, channels: 1, line: { x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y }, trueCount: N };
}
