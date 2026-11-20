// Robustness check on the real photos (npx tsx harness/robust.ts [fixtures]).
// Lines shifted sideways by 0, +-75, +-150 px; band half-widths 4, 6, 10. 6 photos x 15 = 90 runs.
import { decodeImage, loadManifest } from './manifest';
import { countStack, countTolerance } from '../src/algorithm/count';
const dir = process.argv[2] ?? 'fixtures';
let ok = 0, total = 0, badGood = 0;
const fails: string[] = [];
for (const e of loadManifest(dir)) {
  const img = await decodeImage(dir, e.image);
  const L = Math.hypot(e.line.x2 - e.line.x1, e.line.y2 - e.line.y1);
  const nx = -(e.line.y2 - e.line.y1) / L, ny = (e.line.x2 - e.line.x1) / L;
  for (const sh of [0, -75, 75, -150, 150]) for (const band of [4, 6, 10]) {
    const line = { x1: e.line.x1 + sh * nx, y1: e.line.y1 + sh * ny, x2: e.line.x2 + sh * nx, y2: e.line.y2 + sh * ny };
    const r = countStack(img, line, { bandHalfWidth: band });
    const err = r.count === null ? 999 : r.count - e.trueCount!;
    const inTol = Math.abs(err) <= countTolerance(e.trueCount!);
    total++;
    if (inTol) ok++;
    else fails.push(`${e.image} shift ${sh} band ${band}: ${r.count} (period ${r.periodCount}, edges ${r.peakCount}) ${r.confidence}`);
    if (!inTol && r.confidence === 'good') badGood++;
  }
}
console.log(`robustness: ${ok}/${total} within tolerance, wrong good ${badGood}`);
for (const f of fails) console.log('  ' + f);
