// Accuracy harness: run the real algorithm over a folder of annotated photos
// and score it against the true counts.
//
//   npm run harness -- fixtures/            real photos (private, git-ignored)
//   npm run harness -- fixtures-synthetic/  generated set (npm run synth)
//
// Options:
//   --min-share 0.9   fail if fewer than this share are within tolerance
//   --if-present      exit 0 quietly when the folder or manifest is missing
//   --json out.json   also write per-image results

import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { countStack } from '../src/algorithm/count';
import { lineLength } from '../src/algorithm/profile';
import { decodeGray, loadManifest, tolerance } from './manifest';

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const opt = (name: string, fallback: string) => {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback;
};
const optionValues = new Set(['--min-share', '--json'].flatMap((n) => {
  const i = args.indexOf(n);
  return i >= 0 ? [args[i + 1]] : [];
}));
const dir = args.find((a) => !a.startsWith('--') && !optionValues.has(a)) ?? 'fixtures';
const minShare = Number(opt('--min-share', '0.9'));
const jsonOut = opt('--json', '');

if (!existsSync(join(dir, 'manifest.json'))) {
  if (flag('--if-present')) {
    console.log(`harness: no ${join(dir, 'manifest.json')}, skipping.`);
    process.exit(0);
  }
}

const entries = loadManifest(dir).filter((e) => typeof e.trueCount === 'number');
if (entries.length === 0) {
  console.log('harness: no entries with a trueCount.');
  process.exit(flag('--if-present') ? 0 : 1);
}

interface Row {
  image: string;
  trueCount: number;
  count: number | null;
  error: number | null;
  tol: number;
  ok: boolean;
  confidence: string;
  score: number;
  pxPerItem: number | null;
  periodCount: number | null;
  peakCount: number | null;
  ms: number;
  warnings: string[];
}

const rows: Row[] = [];
for (const e of entries) {
  const img = await decodeGray(dir, e.image);
  const t0 = performance.now();
  const r = countStack(img, e.line, e.settings ?? {});
  const ms = performance.now() - t0;
  const trueCount = e.trueCount as number;
  const error = r.count === null ? null : r.count - trueCount;
  const tol = tolerance(trueCount);
  rows.push({
    image: e.image,
    trueCount,
    count: r.count,
    error,
    tol,
    ok: error !== null && Math.abs(error) <= tol,
    confidence: r.confidence,
    score: r.score,
    pxPerItem: r.pxPerItem ?? lineLength(e.line) / Math.max(1, trueCount - 1),
    periodCount: r.periodCount,
    peakCount: r.peakCount,
    ms,
    warnings: r.warnings,
  });
}

const pad = (s: string, n: number) => (s.length >= n ? s : s + ' '.repeat(n - s.length));
const lpad = (s: string, n: number) => (s.length >= n ? s : ' '.repeat(n - s.length) + s);
const nameW = Math.min(40, Math.max(5, ...rows.map((r) => r.image.length)));
console.log(
  [pad('image', nameW), lpad('true', 6), lpad('count', 6), lpad('err', 6), lpad('tol', 5), ' ok ', pad('conf', 6), lpad('score', 6), lpad('px/it', 6), lpad('period', 7), lpad('peaks', 6), lpad('ms', 6)].join(' '),
);
for (const r of rows) {
  console.log(
    [
      pad(r.image.slice(-nameW), nameW),
      lpad(String(r.trueCount), 6),
      lpad(r.count === null ? '-' : String(r.count), 6),
      lpad(r.error === null ? '-' : (r.error > 0 ? '+' : '') + r.error, 6),
      lpad(r.tol.toFixed(0), 5),
      r.ok ? ' ok ' : ' XX ',
      pad(r.confidence, 6),
      lpad(r.score.toFixed(2), 6),
      lpad(r.pxPerItem === null ? '-' : r.pxPerItem.toFixed(1), 6),
      lpad(r.periodCount === null ? '-' : String(r.periodCount), 7),
      lpad(r.peakCount === null ? '-' : String(r.peakCount), 6),
      lpad(r.ms.toFixed(0), 6),
    ].join(' '),
  );
  for (const w of r.warnings) console.log(`${' '.repeat(nameW)}   ! ${w}`);
}

const okCount = rows.filter((r) => r.ok).length;
const share = okCount / rows.length;
const goodMisses = rows.filter((r) => r.confidence === 'good' && !r.ok);
const relErr = rows.map((r) => (r.error === null ? 1 : Math.abs(r.error) / r.trueCount));
const absErr = rows.filter((r) => r.error !== null).map((r) => Math.abs(r.error!));
absErr.sort((a, b) => a - b);
const q = (p: number) => (absErr.length ? absErr[Math.min(absErr.length - 1, Math.floor(p * absErr.length))] : NaN);

// Spearman rank correlation between score and relative error; should be negative.
function ranks(v: number[]): number[] {
  const idx = v.map((x, i) => [x, i] as const).sort((a, b) => a[0] - b[0]);
  const r = new Array<number>(v.length);
  for (let i = 0; i < idx.length; ) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
    for (let k = i; k <= j; k++) r[idx[k][1]] = (i + j) / 2;
    i = j + 1;
  }
  return r;
}
function pearson(a: number[], b: number[]): number {
  const n = a.length;
  const ma = a.reduce((s, x) => s + x, 0) / n;
  const mb = b.reduce((s, x) => s + x, 0) / n;
  let sab = 0;
  let saa = 0;
  let sbb = 0;
  for (let i = 0; i < n; i++) {
    sab += (a[i] - ma) * (b[i] - mb);
    saa += (a[i] - ma) ** 2;
    sbb += (b[i] - mb) ** 2;
  }
  return saa > 0 && sbb > 0 ? sab / Math.sqrt(saa * sbb) : NaN;
}
const spearman = pearson(ranks(rows.map((r) => r.score)), ranks(relErr));

console.log('');
console.log(`within tolerance max(5, 2%): ${okCount}/${rows.length} (${(share * 100).toFixed(1)}%), gate ${(minShare * 100).toFixed(0)}%`);
console.log(`abs error: median ${q(0.5)}, 90th pct ${q(0.9)}, max ${absErr.at(-1) ?? '-'}`);
for (const c of ['good', 'check', 'low']) {
  const g = rows.filter((r) => r.confidence === c);
  if (g.length) console.log(`  ${pad(c, 5)} ${g.length} images, ${g.filter((r) => r.ok).length} within tolerance`);
}
console.log(`confidence vs error (Spearman, want < 0): ${Number.isNaN(spearman) ? 'n/a' : spearman.toFixed(2)}`);
if (goodMisses.length) console.log(`HIGH-CONFIDENCE MISSES: ${goodMisses.map((r) => r.image).join(', ')}`);

if (jsonOut) writeFileSync(jsonOut, JSON.stringify(rows, null, 2));

const pass = share >= minShare && goodMisses.length === 0;
console.log(pass ? 'PASS' : 'FAIL');
process.exit(pass ? 0 : 1);
