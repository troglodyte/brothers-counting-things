// A stack's "look": a colour histogram of the spines around the line, used to
// recognise titles the user has named before. Chromaticity (colour with the
// brightness divided out) plus a coarse brightness band, so the same title
// under different light still matches. On the real photos the same stack from
// two angles scores 0.98 and different titles 0.67 or less.

import type { ImageLike, StripGeometry } from './profile';

const CHROMA_BINS = 8;
const LUMA_BINS = 4;
export const LOOK_SIZE = CHROMA_BINS * CHROMA_BINS * LUMA_BINS;

/** How far either side of the line the look samples: a band of spine, not the shelf. */
export function lookHalfWidth(pxPerItem: number | null): number {
  return Math.round(Math.max(32, 1.5 * (pxPerItem ?? 0)));
}

/**
 * Histogram of a straightened RGBA strip (see StripGeometry), over the columns
 * between the line's two ends. Pure black is skipped: it is the fill outside
 * the photo. Returns a normalised histogram, or null if nothing was sampled.
 */
export function stackLook(strip: ImageLike, geom: StripGeometry): Float32Array | null {
  const ch = strip.channels ?? 4;
  if (ch < 3) throw new Error('stackLook needs a colour image');
  const h = new Float32Array(LOOK_SIZE);
  const u0 = Math.max(0, Math.floor(geom.margin));
  const u1 = Math.min(strip.width - 1, Math.ceil(geom.margin + geom.length));
  // Every other pixel is plenty for a 256-bin histogram. Two passes: the
  // brightness band is relative to the stack's mean, so exposure cancels out.
  const each = (fn: (r: number, g: number, b: number, s: number) => void) => {
    for (let y = 0; y < strip.height; y += 2) {
      for (let x = u0; x <= u1; x += 2) {
        const i = (y * strip.width + x) * ch;
        const r = strip.data[i];
        const g = strip.data[i + 1];
        const b = strip.data[i + 2];
        const s = r + g + b;
        if (s >= 6) fn(r, g, b, s);
      }
    }
  };
  let n = 0;
  let sum = 0;
  each((_r, _g, _b, s) => {
    n++;
    sum += s;
  });
  if (n === 0) return null;
  const mean = sum / n;
  each((r, g, _b, s) => {
    // r/s and g/s rarely exceed 2/3; stretch that range over the bins.
    const rb = Math.min(CHROMA_BINS - 1, Math.floor(((CHROMA_BINS * r) / s) * 1.5));
    const gb = Math.min(CHROMA_BINS - 1, Math.floor(((CHROMA_BINS * g) / s) * 1.5));
    // 0..2x the mean brightness over the bands.
    const lb = Math.min(LUMA_BINS - 1, Math.floor((s / mean / 2) * LUMA_BINS));
    h[(rb * CHROMA_BINS + gb) * LUMA_BINS + lb]++;
  });
  for (let i = 0; i < h.length; i++) h[i] /= n;
  return h;
}

/** Bhattacharyya coefficient: 1 for identical histograms, 0 for disjoint ones. */
export function lookSimilarity(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.sqrt(a[i] * b[i]);
  return s;
}
