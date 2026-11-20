import { describe, expect, it } from 'vitest';
import type { Confidence } from '../src/algorithm/count';
import { Settler, WINDOW_MS, type LiveFrame } from '../src/ui/settle';

const line = (y1: number, y2: number, x = 500) => ({ x1: x, y1, x2: x, y2 });
const f = (count: number, confidence: Confidence = 'good', l = line(100, 900)): LiveFrame => ({ count, confidence, line: l });

function feed(s: Settler<LiveFrame>, frames: (LiveFrame | null)[], t0 = 0): number {
  let t = t0;
  for (const fr of frames) s.push(fr, (t += 150));
  return t;
}

describe('Settler', () => {
  it('shows the count most frames agree on, not the mean', () => {
    const s = new Settler<LiveFrame>();
    feed(s, [f(23), f(23), f(31), f(23), f(22), f(23)]);
    const r = s.settled()!;
    expect(r.count).toBe(23);
    expect(r.steady).toBe(true);
  });

  it('is not steady until enough frames agree', () => {
    const s = new Settler<LiveFrame>();
    feed(s, [f(23), f(23)]);
    expect(s.settled()!.steady).toBe(false);
    const s2 = new Settler<LiveFrame>();
    feed(s2, [f(22), f(23), f(24), f(22), f(23), f(24)]);
    expect(s2.settled()!.steady).toBe(false);
  });

  it('weights good frames above low ones', () => {
    const s = new Settler<LiveFrame>();
    feed(s, [f(23), f(23), f(40, 'low'), f(40, 'low'), f(40, 'low')]);
    expect(s.settled()!.count).toBe(23);
  });

  it('holds the shown count against a near tie (no 22/23 flicker)', () => {
    const s = new Settler<LiveFrame>();
    feed(s, [f(23), f(23), f(23)]);
    const t = feed(s, [f(22), f(22), f(22), f(22)]);
    expect(s.settled()!.count).toBe(23); // 4 vs 3: not a clear lead
    feed(s, [f(22), f(22)], t);
    expect(s.settled()!.count).toBe(22);
  });

  it('forgets frames older than the window', () => {
    const s = new Settler<LiveFrame>();
    const t = feed(s, [f(23), f(23), f(23)]);
    feed(s, [f(24), f(24), f(24), f(24), f(24), f(24)], t + WINDOW_MS);
    expect(s.settled()!.count).toBe(24);
    expect(s.settled()!.steady).toBe(true);
  });

  it('starts over when the line moves to another stack, but not for one stray frame', () => {
    const s = new Settler<LiveFrame>();
    const other = line(300, 600, 200);
    const t = feed(s, [f(60), f(60), f(60), f(60), f(60), f(7, 'good', other)]);
    expect(s.settled()!.count).toBe(60);
    feed(s, [f(7, 'good', other), f(7, 'good', other)], t);
    const r = s.settled()!;
    expect(r.count).toBe(7);
    expect(r.line).toEqual(other);
  });

  it('is not steady while the newest frames are on another stack (the shutter must not use the old line)', () => {
    const s = new Settler<LiveFrame>();
    const other = line(300, 600, 200);
    const t = feed(s, [f(60), f(60), f(60), f(60), f(60), f(7, 'good', other)]);
    expect(s.settled()!.count).toBe(60);
    expect(s.settled()!.steady).toBe(false);
    feed(s, [f(60)], t); // the stray frame was just a stray: steady again
    expect(s.settled()!.steady).toBe(true);
  });

  it('reports the median line of the frames voting for the count', () => {
    const s = new Settler<LiveFrame>();
    feed(s, [f(23, 'good', line(100, 900)), f(23, 'good', line(104, 896)), f(23, 'good', line(140, 900)), f(25, 'good', line(0, 999))]);
    expect(s.settled()!.line).toEqual(line(104, 900));
  });

  it('returns null when nothing has been found lately', () => {
    const s = new Settler<LiveFrame>();
    const t = feed(s, [f(23), f(23)]);
    feed(s, Array(20).fill(null), t);
    expect(s.settled()).toBeNull();
  });
});
