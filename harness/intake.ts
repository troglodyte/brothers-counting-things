// Phase 0 intake: image sizes, pixels per item, and the decision on whether a
// "sections" capture mode is needed.
//
//   npm run intake -- fixtures/

import { join } from 'node:path';
import sharp from 'sharp';
import { lineLength } from '../src/algorithm/profile';
import { median } from '../src/algorithm/signal';
import { loadManifest } from './manifest';

const dir = process.argv[2] ?? 'fixtures';
const entries = loadManifest(dir);

const pxPerItem: number[] = [];
console.log('image                                     size        MP   line px  true  px/item  notes');
for (const e of entries) {
  const meta = await sharp(join(dir, e.image), { limitInputPixels: false }).metadata();
  // EXIF orientations 5-8 swap width and height.
  const swap = (meta.orientation ?? 1) >= 5;
  const w = (swap ? meta.height : meta.width) ?? 0;
  const h = (swap ? meta.width : meta.height) ?? 0;
  const len = e.line ? lineLength(e.line) : NaN;
  const ppi = e.trueCount && e.trueCount > 1 ? len / (e.trueCount - 1) : NaN;
  if (Number.isFinite(ppi)) pxPerItem.push(ppi);
  console.log(
    [
      e.image.slice(-40).padEnd(40),
      `${w}x${h}`.padStart(11),
      ((w * h) / 1e6).toFixed(1).padStart(5),
      (Number.isFinite(len) ? len.toFixed(0) : '-').padStart(8),
      String(e.trueCount ?? '-').padStart(5),
      (Number.isFinite(ppi) ? ppi.toFixed(2) : '-').padStart(8),
      ` ${e.notes ?? ''}`,
    ].join(' '),
  );
}

const m = median(pxPerItem);
console.log('');
if (!Number.isFinite(m)) {
  console.log('No entries with both a line and a trueCount yet.');
} else {
  const below3 = pxPerItem.filter((v) => v < 3).length;
  console.log(`median px/item: ${m.toFixed(2)}  (min ${Math.min(...pxPerItem).toFixed(2)}, ${below3} of ${pxPerItem.length} below 3)`);
  if (m > 6) console.log('Decision: straightforward. Period count with the peak cross-check.');
  else if (m >= 3) console.log('Decision: period method required; peak count is a cross-check only.');
  else console.log('Decision: below 3 px/item. Add the "sections" capture mode to Phase 2.');
}
