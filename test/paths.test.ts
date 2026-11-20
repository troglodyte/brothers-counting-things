// The app (browser) and the harness (Node) must see the same strip for the
// same line, or the harness stops measuring what users get.
//
// The browser straightens with a canvas: setTransform(stripTransform(...)) and
// drawImage. Canvas is not available under Vitest, so `canvasDraw` below
// implements what the canvas does from its spec: each destination pixel
// centre is mapped back through the inverse matrix and the source is sampled
// bilinearly at that point (source pixel i is centred at i + 0.5).

import { describe, expect, it } from 'vitest';
import { countStack, countStrip } from '../src/algorithm/count';
import { extractStrip, stripGeometry, stripSize, stripTransform, type Gray, type ImageLike } from '../src/algorithm/profile';
import { fitView, viewAfterResize, type ViewState } from '../src/ui/placement';
import { synthStack } from './synth';

function canvasDraw(img: ImageLike, m: number[], width: number, height: number): Gray {
  const [a, b, c, d, e, f] = m;
  const det = a * d - b * c;
  const out = new Float32Array(width * height);
  const src = img.data;
  const at = (x: number, y: number) => {
    x = Math.max(0, Math.min(img.width - 1, x));
    y = Math.max(0, Math.min(img.height - 1, y));
    return src[y * img.width + x];
  };
  for (let v = 0; v < height; v++) {
    for (let u = 0; u < width; u++) {
      const px = u + 0.5 - e;
      const py = v + 0.5 - f;
      const X = (d * px - c * py) / det - 0.5;
      const Y = (-b * px + a * py) / det - 0.5;
      const x0 = Math.floor(X);
      const y0 = Math.floor(Y);
      const fx = X - x0;
      const fy = Y - y0;
      out[v * width + u] =
        (at(x0, y0) * (1 - fx) + at(x0 + 1, y0) * fx) * (1 - fy) + (at(x0, y0 + 1) * (1 - fx) + at(x0 + 1, y0 + 1) * fx) * fy;
    }
  }
  return { width, height, data: out };
}

describe('browser and harness straighten the same strip', () => {
  const cases = [
    { label: 'square, thick items', count: 24, pxPerItem: 30, tiltDeg: 0, lineSkewPx: 0 },
    { label: 'tilted, crooked line', count: 40, pxPerItem: 14, tiltDeg: 6, lineSkewPx: 20 },
    { label: 'tilted the other way, thin items', count: 120, pxPerItem: 5, tiltDeg: -4, lineSkewPx: -12 },
  ];
  for (const c of cases) {
    it(c.label, () => {
      const img = synthStack({ ...c, width: 300, noise: 5, perspective: 0.1, seed: 11 });
      // Downward, as the user drags it in the app (first item at the top).
      const line = { x1: img.line.x2, y1: img.line.y2, x2: img.line.x1, y2: img.line.y1 };
      const geom = stripGeometry(line, 32);
      const { width, height } = stripSize(geom);
      const node = extractStrip(img, line, geom);
      const browser = canvasDraw(img, stripTransform(line, geom), width, height);
      expect([browser.width, browser.height]).toEqual([node.width, node.height]);
      let maxDiff = 0;
      for (let i = 0; i < node.data.length; i++) maxDiff = Math.max(maxDiff, Math.abs(node.data[i] - browser.data[i]));
      expect(maxDiff).toBeLessThan(1e-3);

      const a = countStack(img, line);
      const b = countStrip(browser, geom);
      expect(b.count).toBe(a.count);
      expect(b.pxPerItem).toBeCloseTo(a.pxPerItem!, 6);
    });
  }
});

describe('placement keeps the photo still under a drawing finger', () => {
  const view = { w: 3072, h: 4080 };
  const toImage = (s: ViewState, sx: number, sy: number) => ({ x: (sx - s.tx) / s.k, y: (sy - s.ty) / s.k });

  it('does not move the photo when the stage shrinks mid-gesture', () => {
    // The first live count shows the badge and the bar under the stage grows.
    const before = fitView(390, 539, view.w, view.h);
    const after = fitView(390, 474, view.w, view.h);
    expect(viewAfterResize(before, after, true)).toBeNull();
    // What refitting mid-drag used to do: the same screen point now names another image point.
    const moved = toImage(after, 195, 300).y - toImage(before, 195, 300).y;
    expect(Math.abs(moved)).toBeGreaterThan(100);
  });

  it('refits an un-zoomed photo once idle', () => {
    const before = fitView(390, 539, view.w, view.h);
    const after = fitView(390, 474, view.w, view.h);
    expect(viewAfterResize(before, after, false)).toEqual(after);
  });

  it('keeps a zoomed-in view when idle', () => {
    const zoomed: ViewState = { k: 1, kFit: 0.1, tx: -1000, ty: -2000 };
    const next = viewAfterResize(zoomed, fitView(390, 474, view.w, view.h), false)!;
    expect([next.k, next.tx, next.ty]).toEqual([zoomed.k, zoomed.tx, zoomed.ty]);
  });
});
