// Sampling: straighten a strip of the photo around the user's line, measure
// the stripe direction inside it, and average along the stripes to get a 1-D
// brightness profile along the stack.

import { gaussianSmooth } from './signal';

/** Pixels as they come from ImageData (4 channels) or sharp raw output (1-4). */
export interface ImageLike {
  width: number;
  height: number;
  data: ArrayLike<number>;
  /** Interleaved channels per pixel. Defaults to 4 (RGBA). */
  channels?: number;
}

/** Single-channel float image. */
export interface Gray {
  width: number;
  height: number;
  data: Float32Array;
}

export interface Point {
  x: number;
  y: number;
}

/** From the first item to the last item, in full-resolution image pixels. */
export interface Line {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/**
 * A straightened strip: the line runs along row `halfHeight`, from column
 * `margin` to column `margin + length`. Extra `margin` columns on each side
 * let the peak stage see items that sit right on an endpoint.
 */
export interface StripGeometry {
  length: number;
  margin: number;
  halfHeight: number;
}

export function lineLength(l: Line): number {
  return Math.hypot(l.x2 - l.x1, l.y2 - l.y1);
}

export function stripGeometry(line: Line, halfHeight = 32): StripGeometry {
  const length = lineLength(line);
  const margin = Math.ceil(Math.max(16, 0.04 * length));
  return { length, margin, halfHeight };
}

export function stripSize(g: StripGeometry): { width: number; height: number } {
  return { width: Math.ceil(g.length) + 2 * g.margin + 1, height: 2 * g.halfHeight + 1 };
}

function lumaReader(img: ImageLike): (pixelIndex: number) => number {
  const ch = img.channels ?? 4;
  const d = img.data;
  if (ch === 1) return (p) => d[p];
  if (ch === 2) return (p) => d[p * 2];
  return (p) => {
    const o = p * ch;
    return 0.299 * d[o] + 0.587 * d[o + 1] + 0.114 * d[o + 2];
  };
}

export function toGray(img: ImageLike): Gray {
  const n = img.width * img.height;
  const luma = lumaReader(img);
  const data = new Float32Array(n);
  for (let i = 0; i < n; i++) data[i] = luma(i);
  return { width: img.width, height: img.height, data };
}

/**
 * Resample the photo into a strip aligned with the line (bilinear, edges
 * clamped). Reads only the pixels it needs, so a 50 MP photo is fine.
 */
export function extractStrip(img: ImageLike, line: Line, geom: StripGeometry): Gray {
  const { width: W, height: H } = stripSize(geom);
  const L = geom.length || 1;
  const dx = (line.x2 - line.x1) / L;
  const dy = (line.y2 - line.y1) / L;
  const nx = -dy;
  const ny = dx;
  const luma = lumaReader(img);
  const iw = img.width;
  const ih = img.height;
  const out = new Float32Array(W * H);
  for (let v = 0; v < H; v++) {
    const b = v - geom.halfHeight;
    for (let u = 0; u < W; u++) {
      const a = u - geom.margin;
      // Line coordinates are continuous (pixel i spans [i, i+1)); data index i is centred at i + 0.5.
      let x = line.x1 + a * dx + b * nx - 0.5;
      let y = line.y1 + a * dy + b * ny - 0.5;
      if (x < 0) x = 0;
      else if (x > iw - 1) x = iw - 1;
      if (y < 0) y = 0;
      else if (y > ih - 1) y = ih - 1;
      const x0 = Math.floor(x);
      const y0 = Math.floor(y);
      const x1 = Math.min(x0 + 1, iw - 1);
      const y1 = Math.min(y0 + 1, ih - 1);
      const fx = x - x0;
      const fy = y - y0;
      const p00 = luma(y0 * iw + x0);
      const p10 = luma(y0 * iw + x1);
      const p01 = luma(y1 * iw + x0);
      const p11 = luma(y1 * iw + x1);
      out[v * W + u] = (p00 * (1 - fx) + p10 * fx) * (1 - fy) + (p01 * (1 - fx) + p11 * fx) * fy;
    }
  }
  return { width: W, height: H, data: out };
}

function sampleGray(g: Gray, x: number, y: number): number {
  const w = g.width;
  const h = g.height;
  if (x < 0) x = 0;
  else if (x > w - 1) x = w - 1;
  if (y < 0) y = 0;
  else if (y > h - 1) y = h - 1;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(x0 + 1, w - 1);
  const y1 = Math.min(y0 + 1, h - 1);
  const fx = x - x0;
  const fy = y - y0;
  const d = g.data;
  return (
    (d[y0 * w + x0] * (1 - fx) + d[y0 * w + x1] * fx) * (1 - fy) +
    (d[y1 * w + x0] * (1 - fx) + d[y1 * w + x1] * fx) * fy
  );
}

export interface StripeAngle {
  /** Dominant gradient direction in strip coordinates, radians (0 = stripes perpendicular to the line). */
  angle: number;
  /** 0..1, how strongly one orientation dominates. */
  coherence: number;
  /** True when the measurement was unusable and 0 was assumed. */
  assumed: boolean;
}

const MAX_TILT = (30 * Math.PI) / 180;

/**
 * Dominant stripe orientation from the gradient structure tensor (the
 * magnitude-weighted mean of doubled gradient angles, i.e. the peak of a
 * gradient orientation histogram). Using the measured angle rather than the
 * line's normal is what makes a slightly crooked line harmless.
 */
export function estimateStripeAngle(strip: Gray, geom: StripGeometry): StripeAngle {
  const W = strip.width;
  const H = strip.height;
  const d = strip.data;
  const u0 = Math.max(1, geom.margin);
  const u1 = Math.min(W - 2, geom.margin + Math.ceil(geom.length));
  let jxx = 0;
  let jyy = 0;
  let jxy = 0;
  for (let v = 1; v < H - 1; v++) {
    const r0 = (v - 1) * W;
    const r1 = v * W;
    const r2 = (v + 1) * W;
    for (let u = u0; u <= u1; u++) {
      const gx =
        d[r0 + u + 1] + 2 * d[r1 + u + 1] + d[r2 + u + 1] - (d[r0 + u - 1] + 2 * d[r1 + u - 1] + d[r2 + u - 1]);
      const gy =
        d[r2 + u - 1] + 2 * d[r2 + u] + d[r2 + u + 1] - (d[r0 + u - 1] + 2 * d[r0 + u] + d[r0 + u + 1]);
      jxx += gx * gx;
      jyy += gy * gy;
      jxy += gx * gy;
    }
  }
  const total = jxx + jyy;
  if (!(total > 0)) return { angle: 0, coherence: 0, assumed: true };
  const coherence = Math.sqrt((jxx - jyy) ** 2 + 4 * jxy * jxy) / total;
  const angle = 0.5 * Math.atan2(2 * jxy, jxx - jyy);
  if (coherence < 0.15 || Math.abs(angle) > MAX_TILT) return { angle: 0, coherence, assumed: true };
  return { angle, coherence, assumed: false };
}

/**
 * The 1-D profile: for each pixel step along the line (plus `ext` steps
 * beyond each end), the mean brightness along the stripe through that point
 * over +-bandHalfWidth pixels, then a light Gaussian smooth.
 * Index k corresponds to strip column `margin - ext + k`.
 */
export function sampleProfile(
  strip: Gray,
  geom: StripGeometry,
  angle: number,
  bandHalfWidth: number,
  ext: number,
  // 0.5 px, not 1: at 3.5 px per item a sigma of 1 keeps only ~20% of the
  // stripe fundamental and the period is lost. The band average does the denoising.
  sigma = 0.5,
): Float32Array {
  const band = Math.max(0, Math.min(Math.round(bandHalfWidth), geom.halfHeight - 1));
  const n = Math.floor(geom.length + 2 * ext) + 1;
  const sx = -Math.sin(angle);
  const sy = Math.cos(angle);
  const cy = geom.halfHeight;
  const out = new Float32Array(n);
  for (let k = 0; k < n; k++) {
    const u = geom.margin - ext + k;
    let acc = 0;
    for (let t = -band; t <= band; t++) acc += sampleGray(strip, u + t * sx, cy + t * sy);
    out[k] = acc / (2 * band + 1);
  }
  return gaussianSmooth(out, sigma);
}
