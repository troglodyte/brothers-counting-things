import { describe, expect, it } from 'vitest';
import { LOOK_SIZE, lookSimilarity, stackLook } from '../src/algorithm/appearance';
import { closestName, pickTitle, type OcrWord } from '../src/ui/spine';

/** A straightened RGBA strip of horizontal-ish stripes in two alternating colours, with brightness scaled. */
function stripes(c1: number[], c2: number[], light = 1, w = 200, h = 65): { width: number; height: number; data: Uint8ClampedArray } {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const c = Math.floor(x / 10) % 2 ? c1 : c2;
      const i = (y * w + x) * 4;
      data.set([c[0] * light, c[1] * light, c[2] * light, 255], i);
    }
  return { width: w, height: h, data };
}
const geom = { length: 180, margin: 10, halfHeight: 32 };

describe('stack look', () => {
  const blue = stackLook(stripes([40, 60, 160], [200, 200, 210]), geom)!;

  it('is a normalised histogram', () => {
    expect(blue).toHaveLength(LOOK_SIZE);
    expect(blue.reduce((s, v) => s + v, 0)).toBeCloseTo(1, 5);
  });

  it('matches the same title under dimmer light', () => {
    const dim = stackLook(stripes([40, 60, 160], [200, 200, 210], 0.8), geom)!;
    expect(lookSimilarity(blue, dim)).toBeGreaterThan(0.85);
  });

  it('tells a different title apart', () => {
    const red = stackLook(stripes([170, 40, 30], [230, 220, 200]), geom)!;
    expect(lookSimilarity(blue, red)).toBeLessThan(0.6);
  });

  it('ignores the black fill outside the photo', () => {
    expect(stackLook(stripes([0, 0, 0], [0, 0, 0]), geom)).toBeNull();
  });
});

const word = (text: string, x: number, y: number, confidence = 90): OcrWord => ({
  text,
  confidence,
  bbox: { x0: x, y0: y, x1: x + text.length * 12, y1: y + 20 },
});

describe('pickTitle', () => {
  it('picks the title that recurs across items and joins split rows', () => {
    // What Tesseract returned on the Ministry School photo, roughly.
    const words = [
      word('School', 400, 0),
      word('Ministry', 300, 100),
      word('School', 400, 100),
      word('istry', 300, 200),
      word('be-E', 900, 200),
      word('Ministry', 300, 300),
      word('School', 410, 300),
      word('SS', 50, 400),
    ];
    expect(pickTitle(words)).toBe('Ministry School');
  });

  it('completes a cut-off word from another item', () => {
    const words = [word('istry', 300, 0), word('School', 380, 0), word('School', 400, 100), word('Ministry', 250, 200)];
    expect(pickTitle(words)).toBe('Ministry School');
  });

  it('keeps one copy of a word read at two sizes', () => {
    const words = [word('Bearing', 100, 0), word('Bearing', 102, 1), word('Witness', 200, 0), word('Witness', 203, 1), word('Bearing', 100, 100)];
    expect(pickTitle(words)).toBe('Bearing Witness');
  });

  it('drops the start of a second printing of the title on the same spine', () => {
    const words = [word('Bearing', 100, 0), word('Witness', 200, 0), word('Bearing', 300, 0), word('Bearing', 100, 100)];
    expect(pickTitle(words)).toBe('Bearing Witness');
  });

  it('returns null for one-off junk', () => {
    expect(pickTitle([word('Fy', 0, 0), word('rp', 50, 100), word('Weg.g', 0, 200, 82)])).toBeNull();
  });

  it('ignores low-confidence words', () => {
    expect(pickTitle([word('Awake', 0, 0, 40), word('Awake', 0, 100, 40)])).toBeNull();
  });
});

describe('closestName', () => {
  const names = ['Bearing Witness', 'Ministry School', 'Awake'];
  it('maps a fragment or a misread onto a known title', () => {
    expect(closestName('Bearing Wit', names)).toBe('Bearing Witness');
    expect(closestName('Miaistry School', names)).toBe('Ministry School');
  });
  it('returns null when nothing is close', () => {
    expect(closestName('Watchtower', names)).toBeNull();
    expect(closestName('be', names)).toBeNull();
  });
});
