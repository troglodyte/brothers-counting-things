// Distant shots, simulated by shrinking the real photos (npx tsx harness/far.ts [fixtures] [-v]).
// Live mode reads video frames, about 1/4 to 1/6 of a full photo, so this is
// the resolution it works at. Reports, per scale, how many photos are within
// tolerance and how many wrong answers claim "good" or "check".
import sharp from 'sharp';
import { resolve } from 'node:path';
import { loadManifest } from './manifest';
import { countStack, countTolerance } from '../src/algorithm/count';

const args = process.argv.slice(2);
const verbose = args.includes('-v');
const dir = args.find((a) => !a.startsWith('-')) ?? 'fixtures';
const SCALES = [1, 2, 4, 6, 8, 10, 12, 16];

const rows = new Map<number, { ok: number; total: number; wrongGood: number; wrongCheck: number }>();
for (const s of SCALES) rows.set(s, { ok: 0, total: 0, wrongGood: 0, wrongCheck: 0 });

for (const e of loadManifest(dir)) {
  if (e.trueCount === null) continue;
  const full = await sharp(resolve(dir, e.image), { limitInputPixels: false }).rotate().toBuffer();
  const { width: W0 } = await sharp(full).metadata();
  for (const s of SCALES) {
    const { data, info } = await sharp(full).resize({ width: Math.round(W0! / s) }).raw().toBuffer({ resolveWithObject: true });
    const k = info.width / W0!;
    const img = { width: info.width, height: info.height, data, channels: info.channels };
    const l = e.line;
    const r = countStack(img, { x1: l.x1 * k, y1: l.y1 * k, x2: l.x2 * k, y2: l.y2 * k });
    const err = r.count === null ? null : r.count - e.trueCount;
    const inTol = err !== null && Math.abs(err) <= countTolerance(e.trueCount);
    const row = rows.get(s)!;
    row.total++;
    if (inTol) row.ok++;
    else if (r.confidence === 'good') row.wrongGood++;
    else if (r.confidence === 'check') row.wrongCheck++;
    if (verbose || (!inTol && r.confidence !== 'low')) {
      const px = r.pxPerItem?.toFixed(1) ?? '-';
      console.log(`${inTol ? '  ' : '✗ '}${e.image} 1/${s}: ${r.count ?? '-'} of ${e.trueCount} (${r.method}, ${px} px/item) ${r.confidence}${r.warnings.length ? ' | ' + r.warnings.join(' | ') : ''}`);
    }
  }
}
console.log('\nscale  within  wrong good  wrong check');
for (const [s, r] of rows) console.log(`1/${String(s).padEnd(4)} ${r.ok}/${r.total}`.padEnd(14) + `${r.wrongGood}`.padEnd(12) + `${r.wrongCheck}`);
