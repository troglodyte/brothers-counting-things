// Can the count find the stack's ends by itself? (npx tsx harness/autoends.ts [fixtures] [-v])
// Each annotated line is lengthened past both ends by 15/30/50% of its length, as the
// live viewfinder's fixed guide line would be. src/algorithm/autoends.findEnds finds the
// stack on it; countStack then counts between the found ends (as the app does).
// Tuning flags (see AutoEndsOptions): --win --half --bridge --minrun --trim --look --lookrun. Not part of CI.
//
// Result 2026-11-20: energy alone (--look 0) 11/18 within tolerance with one wrong "good"
// (6813 at +50% reached the stack behind). With the look bound, 14/18 and no wrong "good",
// the same for --look 0.15..0.3. Then 17/18 with --minrun 1..1.5 (2 loses 6813 at +15%):
// on 6811 the walk had bridged the shelf's shadow onto its sunlit edge, one item and more
// past the last book (the manifest line also ended in the shadow, since fixed). Miss: 6815
// at +15% is the staggered-stack weakness (low).
import { decodeImage, loadManifest } from './manifest';
import { AUTO_DEFAULTS, findEnds, subLine } from '../src/algorithm/autoends';
import { countStack, countTolerance } from '../src/algorithm/count';
import { extractColourStrip, stripGeometry, type Line } from '../src/algorithm/profile';

const args = process.argv.slice(2);
const dir = args[0] && !args[0].startsWith('-') ? args[0] : 'fixtures';
const verbose = args.includes('-v');
const arg = (k: string, d: number) => {
  const i = args.indexOf('--' + k);
  return i >= 0 ? Number(args[i + 1]) : d;
};
const opts = {
  win: arg('win', AUTO_DEFAULTS.win),
  half: arg('half', AUTO_DEFAULTS.half),
  bridge: arg('bridge', AUTO_DEFAULTS.bridge),
  minRun: arg('minrun', AUTO_DEFAULTS.minRun),
  trim: arg('trim', AUTO_DEFAULTS.trim),
  look: arg('look', AUTO_DEFAULTS.look),
  lookRun: arg('lookrun', AUTO_DEFAULTS.lookRun),
};
const OVERSHOOTS = [0.15, 0.3, 0.5];

function extend(l: Line, f: number): Line {
  const dx = l.x2 - l.x1, dy = l.y2 - l.y1;
  return { x1: l.x1 - f * dx, y1: l.y1 - f * dy, x2: l.x2 + f * dx, y2: l.y2 + f * dy };
}

let ok = 0, total = 0, wrongGood = 0;
for (const e of loadManifest(dir)) {
  if (e.trueCount == null) continue;
  const img = await decodeImage(dir, e.image);
  const L = Math.hypot(e.line.x2 - e.line.x1, e.line.y2 - e.line.y1);
  for (const f of OVERSHOOTS) {
    total++;
    const guide = extend(e.line, f);
    const geom = stripGeometry(guide, 32);
    const ends = findEnds(extractColourStrip(img, guide, geom), geom, opts);
    const r = ends && countStack(img, subLine(guide, ends));
    if (!ends || !r || r.count === null) { console.log(`${e.image} +${f * 100}%: nothing found`); continue; }
    const err = r.count - e.trueCount;
    const inTol = Math.abs(err) <= countTolerance(e.trueCount);
    if (inTol) ok++;
    else if (r.confidence === 'good') wrongGood++;
    // Where the found end items sit relative to the annotated ones, in items.
    const item = L / Math.max(1, e.trueCount - 1);
    const ds = ((ends.start - f * L) / item).toFixed(1), de = ((ends.end - (1 + f) * L) / item).toFixed(1);
    const sign = err >= 0 ? '+' : '';
    const extra = verbose ? `  period ${r.periodCount} edges ${r.peakCount}` : '';
    console.log(`${e.image} +${(f * 100).toFixed(0).padStart(2)}%: ${String(r.count).padStart(3)} of ${e.trueCount} (${sign}${err}) ${r.confidence}${inTol ? '' : ' FAIL'}  ends off by ${ds}/${de} items${extra}`);
  }
}
console.log(`auto ends: ${ok}/${total} within tolerance, wrong good ${wrongGood}`);
