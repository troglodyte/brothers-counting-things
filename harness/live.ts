// Shaky-hand replay of live mode (npx tsx harness/live.ts [fixtures] [-v] [--seed N] [settle flags]).
// Each photo is shrunk to video size (1920 px long side), then ~30 frames 150 ms apart
// are counted as live mode does: a guide line past both ends of the annotated line
// (15/30/50%), jittered per frame by a hand-shake random walk (sideways shift, shift
// along the line, slight rotation and zoom), findEnds -> subLine -> countStack, and the
// result pushed into the Settler (src/ui/settle.ts). Per photo it reports the time to
// the first steady count, whether the steady count is within tolerance, frames showing
// a steady good/check count outside it ("wrong steady", the gate: want 0; wrong but
// *low* is reported apart, as the main harness does), and how often the
// shown count changes after it first went steady (flicker).
// Then a new-stack case: 15 frames of one photo, then 15 of the next, timing how long
// until the readout is steady on the new stack and counting frames that still show a
// steady count wrong for it ("stale steady").
// Settle flags: --window --frames --share --switch --moved --movedframes. Not part of CI.
import sharp from 'sharp';
import { resolve } from 'node:path';
import { loadManifest, type ManifestEntry } from './manifest';
import { findEnds, subLine } from '../src/algorithm/autoends';
import { countStack, countTolerance, DEFAULTS } from '../src/algorithm/count';
import { extractColourStrip, stripGeometry, type ImageLike, type Line } from '../src/algorithm/profile';
import { SETTLE_DEFAULTS, Settler, type LiveFrame } from '../src/ui/settle';

const args = process.argv.slice(2);
const dir = args[0] && !args[0].startsWith('-') ? args[0] : 'fixtures';
const verbose = args.includes('-v');
const arg = (k: string, d: number) => {
  const i = args.indexOf('--' + k);
  return i >= 0 ? Number(args[i + 1]) : d;
};
const settle = {
  windowMs: arg('window', SETTLE_DEFAULTS.windowMs),
  steadyFrames: arg('frames', SETTLE_DEFAULTS.steadyFrames),
  steadyShare: arg('share', SETTLE_DEFAULTS.steadyShare),
  switchRatio: arg('switch', SETTLE_DEFAULTS.switchRatio),
  moved: arg('moved', SETTLE_DEFAULTS.moved),
  movedFrames: arg('movedframes', SETTLE_DEFAULTS.movedFrames),
};
const SEED = arg('seed', 1);
const VIDEO_PX = 1920;
const FRAMES = 30;
const DT = 150;
const OVERSHOOTS = [0.15, 0.3, 0.5];
/** Hand shake, as a share of the guide length / radians / zoom factor (1 sigma of the walk). */
const SHAKE = { side: 0.02, along: 0.02, rot: 0.015, zoom: 0.02 };

/** Seeded RNG (mulberry32) and a normal draw from it. */
function rng(seed: number) {
  let a = seed >>> 0;
  const u = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return () => Math.sqrt(-2 * Math.log(u() || 1e-12)) * Math.cos(2 * Math.PI * u());
}

/** A hand: an AR(1) walk per axis, so shake is correlated from frame to frame. */
function hand(seed: number) {
  const n = rng(seed);
  const s = { side: 0, along: 0, rot: 0, zoom: 0 };
  const a = 0.7, b = Math.sqrt(1 - a * a);
  return () => {
    for (const k of Object.keys(s) as (keyof typeof s)[]) s[k] = a * s[k] + b * SHAKE[k] * n();
    return { ...s };
  };
}

function extend(l: Line, f: number): Line {
  const dx = l.x2 - l.x1, dy = l.y2 - l.y1;
  return { x1: l.x1 - f * dx, y1: l.y1 - f * dy, x2: l.x2 + f * dx, y2: l.y2 + f * dy };
}

/** The guide as it lands on the stack this frame: zoom (about the centre), rotate, shift. */
function shake(g: Line, j: ReturnType<ReturnType<typeof hand>>): Line {
  const cx = (g.x1 + g.x2) / 2, cy = (g.y1 + g.y2) / 2;
  const L = Math.hypot(g.x2 - g.x1, g.y2 - g.y1);
  const ux = (g.x2 - g.x1) / L, uy = (g.y2 - g.y1) / L;
  const c = Math.cos(j.rot), s = Math.sin(j.rot);
  const vx = ux * c - uy * s, vy = ux * s + uy * c;
  const half = (L / 2) / (1 + j.zoom);
  const mx = cx + (j.along * ux - j.side * uy) * L, my = cy + (j.along * uy + j.side * ux) * L;
  return { x1: mx - half * vx, y1: my - half * vy, x2: mx + half * vx, y2: my + half * vy };
}

interface Photo { e: ManifestEntry & { trueCount: number }; img: ImageLike; line: Line }

async function load(): Promise<Photo[]> {
  const out: Photo[] = [];
  for (const e of loadManifest(dir)) {
    if (e.trueCount == null) continue;
    const full = await sharp(resolve(dir, e.image), { limitInputPixels: false }).rotate().toBuffer();
    const { width: W0, height: H0 } = await sharp(full).metadata();
    const k = Math.min(1, VIDEO_PX / Math.max(W0!, H0!));
    const { data, info } = await sharp(full).resize({ width: Math.round(W0! * k) }).raw().toBuffer({ resolveWithObject: true });
    const s = info.width / W0!;
    const l = e.line;
    out.push({
      e: e as Photo['e'],
      img: { width: info.width, height: info.height, data, channels: info.channels },
      line: { x1: l.x1 * s, y1: l.y1 * s, x2: l.x2 * s, y2: l.y2 * s },
    });
  }
  return out;
}

function frame(p: Photo, guide: Line): LiveFrame | null {
  const geom = stripGeometry(guide, DEFAULTS.stripHalfHeight);
  const ends = findEnds(extractColourStrip(p.img, guide, geom), geom);
  if (!ends) return null;
  const line = subLine(guide, ends);
  const r = countStack(p.img, line);
  return r.count === null ? null : { count: r.count, confidence: r.confidence, line };
}

const inTol = (p: Photo, c: number) => Math.abs(c - p.e.trueCount) <= countTolerance(p.e.trueCount);

const photos = await load();
let runs = 0, steadyOk = 0, neverSteady = 0, wrongSteadyRuns = 0, wrongSteadyFrames = 0, wrongLowFrames = 0, flicker = 0;
const firstSteady: number[] = [];
console.log(`settle ${JSON.stringify(settle)}, seed ${SEED}`);
photos.forEach((p, pi) => {
  OVERSHOOTS.forEach((f, fi) => {
    runs++;
    const guide = extend(p.line, f);
    const jit = hand(SEED * 1000 + pi * 10 + fi);
    const st = new Settler<LiveFrame>(settle);
    let first: number | null = null, shown: number | null = null, changes = 0, wrong = 0, wrongLow = 0;
    const raw: string[] = [];
    for (let i = 0; i < FRAMES; i++) {
      const fr = frame(p, shake(guide, jit()));
      raw.push(fr ? `${fr.count}${fr.confidence[0]}` : '-');
      st.push(fr, i * DT);
      const s = st.settled();
      if (!s?.steady) continue;
      if (first === null) first = i * DT;
      else if (s.count !== shown) changes++;
      shown = s.count;
      if (!inTol(p, s.count)) s.confidence === 'low' ? wrongLow++ : wrong++;
    }
    if (first === null) neverSteady++;
    else firstSteady.push(first);
    if (shown !== null && inTol(p, shown)) steadyOk++;
    if (wrong) wrongSteadyRuns++;
    wrongSteadyFrames += wrong;
    wrongLowFrames += wrongLow;
    flicker += changes;
    const err = shown === null ? '-' : `${shown - p.e.trueCount >= 0 ? '+' : ''}${shown - p.e.trueCount}`;
    const flag = wrong ? ' WRONG STEADY' : wrongLow ? ' wrong (low)' : shown === null ? ' never steady' : '';
    console.log(`${p.e.image} +${String(f * 100).padStart(2)}%: steady at ${first ?? '-'} ms, shows ${shown ?? '-'} of ${p.e.trueCount} (${err}), flicker ${changes}, wrong-steady frames ${wrong} (+${wrongLow} low)${flag}`);
    if (verbose) console.log(`   frames: ${raw.join(' ')}`);
  });
});
firstSteady.sort((a, b) => a - b);
const med = firstSteady.length ? firstSteady[firstSteady.length >> 1] : NaN;
console.log(`\nsteady within tolerance ${steadyOk}/${runs}, never steady ${neverSteady}, wrong steady ${wrongSteadyRuns} runs (${wrongSteadyFrames} frames; ${wrongLowFrames} more frames wrong but low), flicker ${flicker}, first steady median ${med} ms / max ${firstSteady.at(-1) ?? '-'} ms`);

// New stack: the hand moves from photo A to photo B mid-run (guide +30%).
const HALF = 15;
let switched = 0, stale = 0, stuck = 0;
const toSteady: number[] = [];
photos.forEach((a, ai) => {
  const b = photos[(ai + 1) % photos.length];
  const jit = hand(SEED * 7919 + ai);
  const st = new Settler<LiveFrame>(settle);
  const ga = extend(a.line, 0.3), gb = extend(b.line, 0.3);
  let at: number | null = null, staleHere = 0;
  for (let i = 0; i < 2 * HALF; i++) {
    const onB = i >= HALF;
    st.push(frame(onB ? b : a, shake(onB ? gb : ga, jit())), i * DT);
    const s = st.settled();
    if (!onB || !s?.steady) continue;
    if (inTol(b, s.count)) at ??= (i - HALF) * DT;
    else if (at === null) staleHere++;
  }
  switched++;
  stale += staleHere;
  if (at === null) stuck++;
  else toSteady.push(at);
  console.log(`${a.e.image} -> ${b.e.image}: steady on new stack after ${at ?? '-'} ms, stale steady frames ${staleHere}${at === null ? ' STUCK' : ''}`);
});
toSteady.sort((x, y) => x - y);
console.log(`new stack: ${switched - stuck}/${switched} settle on the new stack, median ${toSteady[toSteady.length >> 1] ?? '-'} ms, stale steady frames ${stale}`);
