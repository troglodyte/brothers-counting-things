import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import sharp from 'sharp';
import type { CountOptions } from '../src/algorithm/count';
import type { ImageLike, Line } from '../src/algorithm/profile';

export interface ManifestEntry {
  /** Path relative to the manifest's folder. */
  image: string;
  /** First item to last item, full-resolution pixels after EXIF rotation (what the app's "copy annotation" gives). */
  line: Line;
  trueCount: number | null;
  notes?: string;
  settings?: Pick<CountOptions, 'invert' | 'bandHalfWidth'>;
}

/** The manifest lives next to the images: <dir>/manifest.json. */
export function loadManifest(dir: string): ManifestEntry[] {
  const path = join(dir, 'manifest.json');
  if (!existsSync(path)) throw new Error(`No manifest at ${path}. See fixtures/README.md.`);
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(parsed)) throw new Error(`${path} must be a JSON array.`);
  return parsed as ManifestEntry[];
}

/**
 * Decode with EXIF rotation applied, as the browser does with imageOrientation: "from-image".
 * Keeps the colour channels: the algorithm's own luma (profile.toGray, Rec. 601 on sRGB values)
 * makes the grey, as in the browser. sharp's greyscale() weighs channels differently and
 * shifted counts by an item on real photos.
 */
export async function decodeImage(dir: string, image: string): Promise<ImageLike> {
  const { data, info } = await sharp(resolve(dir, image), { limitInputPixels: false })
    .rotate()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, data, channels: info.channels };
}

export { countTolerance as tolerance } from '../src/algorithm/count';
