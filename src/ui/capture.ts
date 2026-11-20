// Photo intake: full-resolution decode with EXIF rotation, a downscaled copy
// for the on-screen view, and canvas straightening of the strip under the line.

import type { Line, StripGeometry } from '../algorithm/profile';
import { stripSize } from '../algorithm/profile';

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
  const L = geom.length || 1;
  const dx = (line.x2 - line.x1) / L;
  const dy = (line.y2 - line.y1) / L;
  const nx = -dy;
  const ny = dx;
  // Image point p maps to strip pixel (u, v) = (margin + (p - p1).d, halfHeight + (p - p1).n).
  // Canvas pixel u is centred at u + 0.5, hence the half-pixel shift.
  ctx.setTransform(
    dx,
    nx,
    dy,
    ny,
    geom.margin + 0.5 - (line.x1 * dx + line.y1 * dy),
    geom.halfHeight + 0.5 - (line.x1 * nx + line.y1 * ny),
  );
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  return { canvas, image: ctx.getImageData(0, 0, width, height) };
}
