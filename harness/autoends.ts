// Experiment: can the count find the stack's ends by itself? (npx tsx harness/autoends.ts [fixtures] [-v])
// Each annotated line is lengthened past both ends by 15/30/50% of its length, as a fixed
// guide line in a live viewfinder would be. Pass 1 finds the stack on that line by stripe
// energy (see findStack); pass 2 runs the ordinary countStack between the found ends.
// Tuning flags: --half --bridge --trim --win. Not part of CI.
// Result 2026-11-20 (defaults): energy alone 11/18 within tolerance with one wrong "good"
// (6813 at +50% reached the stack behind). With the look bound (--look 0.2) 14/18 and no
// wrong "good", the same for --look 0.15..0.3. Misses: 6811 counts 25 of ~23 with the ends
// right; 6815 at +15% is the staggered-stack weakness (low).
import { decodeImage, loadManifest } from './manifest';
import { countStack, countTolerance, type Confidence } from '../src/algorithm/count';
import { windowedPeriod } from '../src/algorithm/period';
import { estimateStripeAngle, extractStrip, sampleProfile, stripGeometry, type Line } from '../src/algorithm/profile';
import { boxSmooth, median } from '../src/algorithm/signal';
import { lookSimilarity, stackLook } from '../src/algorithm/appearance';
import type { ImageLike } from '../src/algorithm/profile';

/** Colour version of extractStrip (nearest neighbour; enough for a histogram). */
function colourStrip(img: ImageLike, line: Line, geom: ReturnType<typeof stripGeometry>): ImageLike {
  const W = Math.ceil(geom.length) + 2 * geom.margin + 1, H = 2 * geom.halfHeight + 1;
  const L = geom.length || 1, dx = (line.x2 - line.x1) / L, dy = (line.y2 - line.y1) / L;
  const ch = img.channels ?? 4;
  const out = new Uint8ClampedArray(W * H * 4);
  for (let v = 0; v < H; v++) for (let u = 0; u < W; u++) {
    const a = u - geom.margin, b = v - geom.halfHeight;
    const x = Math.round(line.x1 + a * dx - b * dy - 0.5), y = Math.round(line.y1 + a * dy + b * dx - 0.5);
    const o = (v * W + u) * 4;
    if (x < 0 || y < 0 || x >= img.width || y >= img.height) continue; // black = outside, skipped by stackLook
    const i = (y * img.width + x) * ch;
    out[o] = img.data[i]; out[o + 1] = img.data[i + 1]; out[o + 2] = img.data[i + 2]; out[o + 3] = 255;
  }
  return { width: W, height: H, data: out, channels: 4 };
}

const dir = process.argv[2] && !process.argv[2].startsWith('-') ? process.argv[2] : 'fixtures';
const verbose = process.argv.includes('-v');
const OVERSHOOTS = [0.15, 0.3, 0.5];

function extend(l: Line, f: number): Line {
  const dx = l.x2 - l.x1, dy = l.y2 - l.y1;
  return { x1: l.x1 - f * dx, y1: l.y1 - f * dy, x2: l.x2 + f * dx, y2: l.y2 + f * dy };
}

interface Found { count: number; start: number; end: number; notes: string; confidence: Confidence }

/**
 * The stack is where the stripe pattern has energy. Energy is the RMS of the detrended
 * profile over WIN local periods; the stack's level is its median over the middle third
 * of the guide line (the user aims the middle at the stack). Walk out from the middle
 * while the energy stays above HALF of that level, bridging dips shorter than BRIDGE
 * periods. A blurred step crosses half its height at the step, so the crossings are the
 * stack's outer edges, and the count is the integral of 1/period between them.
 */
const arg = (k: string, d: number) => { const i = process.argv.indexOf('--' + k); return i > 0 ? Number(process.argv[i + 1]) : d; };
const LOOK = arg('look', 0.2), LOOKRUN = arg('lookrun', 2);
const WIN = arg('win', 1), HALF = arg('half', 0.5), BRIDGE = arg('bridge', 3), TRIM = arg('trim', 1);
function findStack(img: Parameters<typeof extractStrip>[0], line: Line): Found | null {
  const geom = stripGeometry(line, 32);
  const strip = extractStrip(img, line, geom);
  const angle = estimateStripeAngle(strip, geom);
  const ext = geom.margin;
  const profile = sampleProfile(strip, geom, angle.angle, 6, ext);
  const per = windowedPeriod(profile, ext, geom.length, { periodsPerWindow: 25 });
  if (!per) return null;
  const d = per.detrended;
  const n = d.length;
  const pMid = per.periodAt(ext + geom.length / 2);
  const sq = new Float32Array(n);
  for (let i = 0; i < n; i++) sq[i] = d[i] * d[i];
  const en = boxSmooth(sq, Math.max(3, Math.round(WIN * pMid))).map(Math.sqrt);
  const mid = Math.round(ext + geom.length / 2);
  const ref = median(Array.from(en.subarray(Math.round(ext + geom.length / 3), Math.round(ext + (2 * geom.length) / 3))));
  const thr = HALF * ref;
  const walk = (dir: 1 | -1, lo = ext, hi = ext + geom.length): number => {
    let i = mid, lastIn = mid;
    while (i + dir >= lo && i + dir <= hi) {
      i += dir;
      if (en[i] >= thr) lastIn = i;
      else if (Math.abs(i - lastIn) > BRIDGE * per.periodAt(i)) break;
    }
    // Sub-sample crossing just outside lastIn.
    const j = lastIn + dir;
    if (j < 0 || j >= n || en[j] >= thr) return lastIn;
    return lastIn + (dir * (en[lastIn] - thr)) / (en[lastIn] - en[j]);
  };
  let A0 = walk(-1), B0 = walk(1);
  // Look cap: walk out one item-sized slice at a time while the slice's colour histogram
  // resembles the middle third's; LOOKRUN dissimilar slices in a row end the stack.
  const cs = colourStrip(img, line, geom);
  const lookOf = (from: number, to: number) => stackLook(cs, { margin: from, length: to - from, halfHeight: geom.halfHeight });
  const refLook = lookOf(ext + geom.length / 3, ext + (2 * geom.length) / 3);
  const sims: string[] = [];
  const lookWalk = (dir: 1 | -1): number => {
    let x = mid, edge = mid, bad = 0;
    while (true) {
      const p = per.periodAt(x), nx = x + dir * p;
      if (nx < ext || nx > ext + geom.length) return dir > 0 ? ext + geom.length : ext;
      const l = lookOf(Math.min(x, nx), Math.max(x, nx));
      const sim = l && refLook ? lookSimilarity(l, refLook) : 0;
      sims.push(sim.toFixed(2));
      if (sim >= LOOK) { edge = nx; bad = 0; } else if (++bad >= LOOKRUN) return edge;
      x = nx;
    }
  };
  let lookNote = '';
  if (LOOK > 0 && refLook) {
    const la = lookWalk(-1); sims.push('|'); const lb = lookWalk(1);
    // The look only bounds the energy walk (one period past the last stack-like slice);
    // the energy crossing still places the edge.
    const capA = la - per.periodAt(la) > A0, capB = lb + per.periodAt(lb) < B0;
    if (capA) A0 = walk(-1, Math.round(la - per.periodAt(la)), ext + geom.length);
    if (capB) B0 = walk(1, ext, Math.round(lb + per.periodAt(lb)));
    lookNote = ` look-capped ${capA ? 'top ' : ''}${capB ? 'bottom' : ''} [${sims.join(' ')}]`;
  }
  // The stack/background step adds energy of its own; trim TRIM periods off each end.
  const A = A0 + TRIM * per.periodAt(A0), B = B0 - TRIM * per.periodAt(B0);
  let items = 0;
  for (let x = A; x < B; x += 1) items += Math.min(1, B - x) / per.periodAt(x);
  // Centres of the end items, in px along the guide line.
  const start = A + per.periodAt(A) / 2 - ext, end = B - per.periodAt(B) / 2 - ext;
  // Second pass: the ordinary count on a line between those centres, so the period is
  // measured on the stack alone.
  const L = geom.length, ux = (line.x2 - line.x1) / L, uy = (line.y2 - line.y1) / L;
  const sub = { x1: line.x1 + start * ux, y1: line.y1 + start * uy, x2: line.x1 + end * ux, y2: line.y1 + end * uy };
  const r = countStack(img, sub);
  if (r.count === null) return null;
  const count = r.count;
  return { count, start, end, confidence: r.confidence, notes: `${lookNote} edge-to-edge ${items.toFixed(2)}, pass 2 period ${r.periodCount} edges ${r.peakCount} ${r.confidence}` };
}

let ok = 0, total = 0;
for (const e of loadManifest(dir)) {
  if (e.trueCount == null) continue;
  const img = await decodeImage(dir, e.image);
  const L = Math.hypot(e.line.x2 - e.line.x1, e.line.y2 - e.line.y1);
  for (const f of OVERSHOOTS) {
    const r = findStack(img, extend(e.line, f));
    total++;
    if (!r) { console.log(`${e.image} +${f * 100}%: nothing found`); continue; }
    const err = r.count - e.trueCount;
    const inTol = Math.abs(err) <= countTolerance(e.trueCount);
    if (inTol) ok++;
    // Where the annotated ends fall on the extended line.
    const trueStart = f * L, trueEnd = (1 + f) * L;
    const item = L / Math.max(1, e.trueCount - 1);
    const ds = ((r.start - trueStart) / item).toFixed(1), de = ((r.end - trueEnd) / item).toFixed(1);
    console.log(`${e.image} +${(f * 100).toFixed(0).padStart(2)}%: ${String(r.count).padStart(3)} of ${e.trueCount} (${err >= 0 ? '+' : ''}${err}) ${r.confidence}${inTol ? '' : ' FAIL'}  ends off by ${ds}/${de} items${verbose ? '  ' + r.notes : ''}`);
  }
}
console.log(`auto ends: ${ok}/${total} within tolerance`);
