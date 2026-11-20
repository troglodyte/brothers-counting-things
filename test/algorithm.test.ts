import { describe, expect, it } from 'vitest';
import { countStack } from '../src/algorithm/count';
import { countPeaks } from '../src/algorithm/peaks';
import { estimateGlobalPeriod, windowedPeriod } from '../src/algorithm/period';
import { detrend, parabolicOffset } from '../src/algorithm/signal';
import { rng, synthProfile, synthStack } from './synth';

const within = (got: number, want: number, rel: number) => Math.abs(got - want) <= Math.max(1, rel * want);

describe('signal helpers', () => {
  it('parabolic offset finds the vertex', () => {
    // y = -(x - 0.3)^2 sampled at -1, 0, 1
    const f = (x: number) => -((x - 0.3) ** 2);
    expect(parabolicOffset(f(-1), f(0), f(1))).toBeCloseTo(0.3, 6);
  });

  it('detrend removes a ramp but keeps the stripes', () => {
    const n = 400;
    const x = new Float32Array(n);
    for (let i = 0; i < n; i++) x[i] = 0.5 * i + 10 * Math.sin((2 * Math.PI * i) / 8);
    const d = detrend(x, 8);
    let mean = 0;
    for (let i = 50; i < 350; i++) mean += d[i];
    expect(Math.abs(mean / 300)).toBeLessThan(0.5);
    let peak = 0;
    for (let i = 50; i < 350; i++) peak = Math.max(peak, d[i]);
    expect(peak).toBeGreaterThan(8);
  });
});

describe('global period', () => {
  for (const period of [3.1, 4.6, 7.3, 15.2, 42]) {
    it(`finds period ${period}`, () => {
      const { profile, ext, coreLength } = synthProfile({ count: 120, period, noise: 4, seed: 3 });
      const g = estimateGlobalPeriod(profile, ext, ext + Math.floor(coreLength) + 1);
      expect(g).not.toBeNull();
      expect(Math.abs(g!.period - period) / period).toBeLessThan(0.03);
    });
  }
});

describe('windowed period count (within 1 percent)', () => {
  const cases = [
    { name: 'clean fine', count: 800, period: 3.4 },
    { name: 'clean brochure', count: 400, period: 5.2 },
    { name: 'magazines', count: 60, period: 22 },
    { name: 'noisy', count: 500, period: 4.3, noise: 12 },
    { name: 'brightness gradient', count: 500, period: 4.8, noise: 5, gradient: 120 },
    { name: '5 percent edges missing', count: 600, period: 4.1, noise: 5, missingEdgeRate: 0.05 },
    { name: 'perspective 15 percent', count: 700, period: 4.5, noise: 5, perspective: 0.15 },
    {
      name: 'everything at once',
      count: 1000,
      period: 3.6,
      noise: 8,
      gradient: 80,
      missingEdgeRate: 0.05,
      perspective: 0.1,
    },
  ];
  for (const c of cases) {
    it(c.name, () => {
      const { profile, ext, coreLength } = synthProfile({ ...c, seed: 11 });
      const r = windowedPeriod(profile, ext, coreLength);
      expect(r).not.toBeNull();
      expect(within(r!.count, c.count, 0.01)).toBe(true);
    });
  }
});

describe('peak cross-check', () => {
  it('is exact on thick, clean items', () => {
    const { profile, ext, coreLength } = synthProfile({ count: 80, period: 14, noise: 2, seed: 5 });
    const r = windowedPeriod(profile, ext, coreLength)!;
    const p = countPeaks(r.detrended, r.periodAt, ext, ext + coreLength);
    expect(p.count).toBe(80);
  });

  it('is close on finer items', () => {
    const { profile, ext, coreLength } = synthProfile({ count: 300, period: 5, noise: 4, seed: 6 });
    const r = windowedPeriod(profile, ext, coreLength)!;
    const p = countPeaks(r.detrended, r.periodAt, ext, ext + coreLength);
    expect(within(p.count, 300, 0.02)).toBe(true);
  });
});

describe('countStack on synthetic photos (within 1 percent)', () => {
  const cases = [
    { name: 'brochures, square-on', count: 300, pxPerItem: 5, noise: 6 },
    { name: 'thin, tilted 4 degrees, crooked line', count: 400, pxPerItem: 3.5, noise: 6, tiltDeg: 4, lineSkewPx: 12 },
    { name: 'magazines with perspective', count: 70, pxPerItem: 18, noise: 6, perspective: 0.12 },
    {
      name: 'gradient, missing edges, jitter',
      count: 500,
      pxPerItem: 4.2,
      noise: 8,
      gradient: 0.4,
      missingEdgeRate: 0.05,
      jitter: 0.03,
      perspective: 0.08,
    },
  ];
  for (const c of cases) {
    it(c.name, () => {
      const img = synthStack({ ...c, seed: 21 });
      const r = countStack(img, img.line);
      expect(r.count).not.toBeNull();
      expect(within(r.count!, img.trueCount, 0.01)).toBe(true);
      expect(r.confidence).not.toBe('low');
    });
  }

  it('says when the line is too short', () => {
    const img = synthStack({ count: 50, pxPerItem: 5, seed: 1 });
    const r = countStack(img, { x1: 10, y1: 10, x2: 12, y2: 12 });
    expect(r.count).toBeNull();
    expect(r.warnings.length).toBeGreaterThan(0);
  });

  it('flags a featureless region instead of inventing a number', () => {
    const W = 200;
    const H = 600;
    // Not a bare LCG: a 13-px band of `(s * 1103515245 + 12345) >>> 16` noise
    // autocorrelates at 0.88 with lag 44 rows, which is a real period.
    const rand = rng(5);
    const data = new Uint8ClampedArray(W * H);
    for (let i = 0; i < data.length; i++) data[i] = 128 + Math.floor(rand() * 7) - 3;
    const r = countStack({ width: W, height: H, data, channels: 1 }, { x1: 100, y1: 50, x2: 100, y2: 550 });
    expect(r.confidence).not.toBe('good');
  });
});

describe('thick items: books and thick magazines, a few dozen per stack', () => {
  // Real photos of 7 to 60 books at 30 to 240 px per item: few items, strong
  // perspective, and labels or gloss inside each item.
  it('short stack with strong perspective is exact', () => {
    // Spacing changes by 35 percent along the line, as on a book stack shot
    // from above. Over the whole line the narrow gap lines then have no clear
    // autocorrelation peak; seeds 2, 12 and 33 used to lock onto 2 or 4 items.
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 33]) {
      const img = synthStack({ count: 23, pxPerItem: 130, edgeWidthPx: 8, noise: 4, perspective: 0.35, seed });
      const r = countStack(img, img.line);
      expect([seed, r.periodCount, r.peakCount, r.count]).toEqual([seed, 23, 23, 23]);
    }
  });

  it('a few very thick items do not lock onto two items each', () => {
    for (let seed = 1; seed <= 10; seed++) {
      const img = synthStack({ count: 8, pxPerItem: 230, edgeWidthPx: 12, noise: 4, perspective: 0.1, seed });
      const r = countStack(img, img.line);
      expect([seed, r.count]).toEqual([seed, 8]);
    }
  });

  for (const seed of [41, 42, 43]) {
    it(`a bright label or gloss inside each item is not counted (seed ${seed})`, () => {
      // Half the items carry one, as when the line crosses some spine labels.
      const img = synthStack({
        count: 20,
        pxPerItem: 200,
        edgeWidthPx: 10,
        noise: 4,
        perspective: 0.1,
        highlight: 60,
        highlightRate: 0.5,
        seed,
      });
      const r = countStack(img, img.line);
      expect(r.peakCount).toBe(20);
      expect(r.count).toBe(20);
    });
  }

  it('the edge count does not depend on whether ticks sit on item centres or on the gaps', () => {
    // Count items 5 to 19 of a longer stack, so the stack continues past both
    // ends of the line. The gaps beside the end items then sit exactly half a
    // period beyond each endpoint, where a count of ticks in a window flips
    // between 14, 15 and 16.
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const period = 120;
      const { profile, ext, coreLength } = synthProfile({ count: 25, period, noise: 3, seed });
      const r = windowedPeriod(profile, ext, coreLength)!;
      const from = ext + 5 * period;
      const to = ext + 19 * period;
      const gaps = r.detrended.map((v) => -v);
      expect(countPeaks(gaps, r.periodAt, from, to).count).toBe(15);
      expect(countPeaks(r.detrended, r.periodAt, from, to).count).toBe(15);
    }
  });
});
