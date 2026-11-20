// Generate a public, synthetic harness set: JPEG stack photos with known
// counts and lines, so CI has an end-to-end regression gate even without the
// private real photos.
//
//   npm run synth [-- out-dir]   (default fixtures-synthetic/)

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { rng, synthStack, type StackImageOptions } from '../test/synth';
import type { ManifestEntry } from './manifest';

const out = process.argv[2] ?? 'fixtures-synthetic';
mkdirSync(out, { recursive: true });

const rand = rng(2024);
const pick = (lo: number, hi: number) => lo + (hi - lo) * rand();

const configs: (StackImageOptions & { label: string })[] = [];
// Brochures and thin magazines across the practical px-per-item range.
for (let i = 0; i < 24; i++) {
  const pxPerItem = pick(3, 9);
  const count = Math.round(pick(150, Math.min(1400, 5200 / pxPerItem)));
  configs.push({
    label: `brochure-${String(i).padStart(2, '0')}`,
    count,
    pxPerItem,
    width: 320,
    noise: pick(3, 10),
    tiltDeg: pick(-4, 4),
    lineSkewPx: pick(-15, 15),
    perspective: pick(0, 0.15),
    jitter: pick(0, 0.03),
    gradient: pick(0, 0.5),
    missingEdgeRate: pick(0, 0.05),
    seed: 1000 + i,
  });
}
// Thick magazines.
for (let i = 0; i < 6; i++) {
  configs.push({
    label: `magazine-${i}`,
    count: Math.round(pick(25, 120)),
    pxPerItem: pick(10, 35),
    width: 360,
    noise: pick(3, 8),
    tiltDeg: pick(-3, 3),
    perspective: pick(0, 0.12),
    jitter: pick(0, 0.02),
    gradient: pick(0, 0.4),
    seed: 2000 + i,
  });
}

const manifest: ManifestEntry[] = [];
for (const c of configs) {
  const img = synthStack(c);
  const file = `${c.label}.jpg`;
  await sharp(Buffer.from(img.data.buffer, img.data.byteOffset, img.data.byteLength), {
    raw: { width: img.width, height: img.height, channels: 1 },
  })
    .jpeg({ quality: 88 })
    .toFile(join(out, file));
  const r1 = (v: number) => Math.round(v * 10) / 10;
  manifest.push({
    image: file,
    line: { x1: r1(img.line.x1), y1: r1(img.line.y1), x2: r1(img.line.x2), y2: r1(img.line.y2) },
    trueCount: img.trueCount,
    notes: `synthetic: ${c.pxPerItem.toFixed(1)} px/item, noise ${c.noise?.toFixed(1)}, tilt ${c.tiltDeg?.toFixed(1)} deg`,
  });
  process.stdout.write('.');
}
writeFileSync(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log(`\nwrote ${manifest.length} images to ${out}/`);
