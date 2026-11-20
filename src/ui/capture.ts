// Photo intake: full-resolution decode with EXIF rotation, a downscaled copy
// for the on-screen view, and canvas straightening of the strip under the line.

import type { Line, StripGeometry } from '../algorithm/profile';
import { stripSize, stripTransform } from '../algorithm/profile';

export async function decodePhoto(file: File): Promise<ImageBitmap> {
  try {
    return await createImageBitmap(file, { imageOrientation: 'from-image' } as ImageBitmapOptions);
  } catch {
    // Older engines reject the option value; current ones apply EXIF rotation by default.
    return createImageBitmap(file);
  }
}

/** Keep the on-screen copy within what phone GPUs and canvas limits handle comfortably. */
export function makeViewCanvas(bitmap: ImageBitmap): HTMLCanvasElement {
  const maxSide = 4096;
  const maxArea = 16e6;
  const s = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height), Math.sqrt(maxArea / (bitmap.width * bitmap.height)));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(bitmap.width * s));
  c.height = Math.max(1, Math.round(bitmap.height * s));
  const ctx = c.getContext('2d')!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, c.width, c.height);
  c.className = 'view';
  return c;
}

/**
 * Draw the band under the line, rotated so the line runs left to right along
 * the middle row, at full resolution. Reads only these pixels, never the
 * whole 50 MP photo.
 */
export function straightenStrip(bitmap: ImageBitmap, line: Line, geom: StripGeometry): { canvas: HTMLCanvasElement; image: ImageData } {
  const { width, height } = stripSize(geom);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, width, height);
  // Same sampling grid as profile.extractStrip (the harness path); test/paths.test.ts checks they agree.
  ctx.setTransform(...stripTransform(line, geom));
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  return { canvas, image: ctx.getImageData(0, 0, width, height) };
}
