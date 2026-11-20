// Live mode's end finder: the stack on a guide line that runs past both ends.
// The real-photo measure is harness/autoends.ts; these pin the behaviour on
// synthetic stacks, where the background past the ends is plain.

import { describe, expect, it } from 'vitest';
import { findEnds, guideLine, subLine } from '../src/algorithm/autoends';
import { countStack, countTolerance } from '../src/algorithm/count';
import { extractColourStrip, extractStrip, stripGeometry, toGray, type ImageLike, type Line } from '../src/algorithm/profile';
import { synthStack } from './synth';

/** Gray synthetic photo as RGB, tinted so the look histogram has a colour to match. */
function tinted(img: ImageLike): ImageLike {
  const n = img.width * img.height;
  const out = new Uint8ClampedArray(n * 3);
  for (let i = 0; i < n; i++) {
    const v = img.data[i];
    out[i * 3] = v;
    out[i * 3 + 1] = 0.8 * v;
    out[i * 3 + 2] = 0.6 * v;
  }
  return { width: img.width, height: img.height, data: out, channels: 3 };
}

function extend(l: Line, f: number): Line {
  const dx = l.x2 - l.x1;
  const dy = l.y2 - l.y1;
  return { x1: l.x1 - f * dx, y1: l.y1 - f * dy, x2: l.x2 + f * dx, y2: l.y2 + f * dy };
}

describe('extractColourStrip', () => {
  it('samples the same grid as extractStrip', () => {
    const img = tinted(synthStack({ count: 20, pxPerItem: 12, tiltDeg: 4, noise: 4, seed: 3 }));
    const line = { x1: 100, y1: 30, x2: 130, y2: 200 };
    const geom = stripGeometry(line, 32);
    const gray = extractStrip(img, line, geom);
    const fromColour = toGray(extractColourStrip(img, line, geom));
    let maxDiff = 0;
    for (let i = 0; i < gray.data.length; i++) maxDiff = Math.max(maxDiff, Math.abs(gray.data[i] - fromColour.data[i]));
    // Only rounding to 8-bit channels separates them.
    expect(maxDiff).toBeLessThan(1);
  });
});

describe('findEnds', () => {
  const cases = [
    { label: 'thick items', count: 12, pxPerItem: 40 },
    { label: 'medium items, perspective', count: 25, pxPerItem: 16, perspective: 0.15 },
    { label: 'thin items', count: 60, pxPerItem: 7 },
  ];
  for (const c of cases) {
    for (const f of [0.15, 0.3]) {
      it(`${c.label}, guide ${f * 100}% past each end`, () => {
        const synth = synthStack({ ...c, noise: 4, seed: 5, marginPx: Math.round(c.count * c.pxPerItem * 0.6) });
        const img = tinted(synth);
        const guide = extend(synth.line, f);
        const geom = stripGeometry(guide, 32);
        const ends = findEnds(extractColourStrip(img, guide, geom), geom);
        expect(ends).not.toBeNull();
        // The found end items, in items from the true ones, positive inwards. The trim
        // keeps them off the background: without it both land about 0.7 items outside,
        // which the count tolerance alone lets through (one item too many).
        const L = Math.hypot(synth.line.x2 - synth.line.x1, synth.line.y2 - synth.line.y1);
        const item = L / (c.count - 1);
        const inStart = (ends!.start - f * L) / item;
        const inEnd = ((1 + f) * L - ends!.end) / item;
        for (const off of [inStart, inEnd]) {
          expect(off).toBeGreaterThan(-0.25);
          expect(off).toBeLessThan(0.75);
        }
        const r = countStack(img, subLine(guide, ends!));
        expect(Math.abs(r.count! - c.count)).toBeLessThanOrEqual(countTolerance(c.count));
      });
    }
  }

  // 6811: under the stack the shelf is in shadow, then sunlit. The single
  // shadow/light step has about one period of stripe energy, and the dip
  // before it is shorter than the bridge, so the walk used to cross the dip
  // and end the stack on the step, a whole item and more past the last one.
  it('does not take a lone background step past a short dip for more stack', () => {
    const c = { count: 12, pxPerItem: 40 };
    const synth = synthStack({ ...c, noise: 4, seed: 5, marginPx: 300 });
    const bottom = Math.ceil(synth.height / 2 + (c.count * c.pxPerItem) / 2);
    for (let y = bottom + 2.5 * c.pxPerItem; y < synth.height; y++) synth.data.fill(150, y * synth.width, (y + 1) * synth.width);
    const img = tinted(synth);
    const guide = extend(synth.line, 0.5);
    const geom = stripGeometry(guide, 32);
    const ends = findEnds(extractColourStrip(img, guide, geom), geom);
    expect(ends).not.toBeNull();
    // The guide starts half the line's length (11 items) below the bottom item's centre.
    expect(Math.abs(ends!.start - 0.5 * (c.count - 1) * c.pxPerItem)).toBeLessThan(0.5 * c.pxPerItem);
    const r = countStack(img, subLine(guide, ends!));
    expect(Math.abs(r.count! - c.count)).toBeLessThanOrEqual(countTolerance(c.count));
  });

  it('finds nothing on a blank wall', () => {
    const n = 200 * 400;
    const img = { width: 200, height: 400, data: new Uint8ClampedArray(n * 3).fill(128), channels: 3 };
    const guide = guideLine(200, 400);
    const geom = stripGeometry(guide, 32);
    expect(findEnds(extractColourStrip(img, guide, geom), geom)).toBeNull();
  });
});

describe('subLine', () => {
  it('takes the stretch between two distances along the guide', () => {
    expect(subLine({ x1: 10, y1: 0, x2: 10, y2: 100 }, { start: 20, end: 70 })).toEqual({ x1: 10, y1: 20, x2: 10, y2: 70 });
  });
});
