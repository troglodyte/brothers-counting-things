import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LOOK_SIZE } from '../src/algorithm/appearance';
import { Camera } from '../src/ui/camera';
import { pinchTakeover, type Mode } from '../src/ui/placement';
import { parseEntries, Tally } from '../src/ui/tally';
import { parseTitles, Titles } from '../src/ui/titles';

const P = (x: number, y: number) => ({ x, y });

describe('pinchTakeover', () => {
  const before = [P(0, 0), P(10, 0)];
  const now = [P(0, 0), P(50, 5)];
  const draw = (moved: boolean): Mode => ({ kind: 'draw', pointer: 1, start: P(0, 0), startClient: P(0, 0), before, moved });

  it('abandons a line being drawn and asks for a recount of the old one', () => {
    expect(pinchTakeover(draw(true), now)).toBe(before);
  });
  it('leaves things alone if the finger had not moved yet', () => {
    expect(pinchTakeover(draw(false), now)).toBeNull();
  });
  it('keeps a dragged handle where it is and asks for a recount', () => {
    expect(pinchTakeover({ kind: 'handle', index: 1, pointer: 1 }, now)).toBe(now);
  });
  it('does nothing without a one-finger gesture', () => {
    expect(pinchTakeover({ kind: 'none' }, now)).toBeNull();
  });
});

function fakeStorage(items: Record<string, string>) {
  return {
    getItem: (k: string) => items[k] ?? null,
    setItem: (k: string, v: string) => void (items[k] = v),
  };
}

describe('saved data', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('drops damaged list entries instead of trusting them', () => {
    const got = parseEntries([
      null,
      'x',
      { name: 'A', count: 12, confidence: 'good', at: 5 },
      { name: 'B', count: '12', confidence: 'good', at: 5 },
      { name: 'C', count: 0, confidence: 'good', at: 5 },
      { name: 7, count: 3, confidence: 'great' },
    ]);
    expect(got).toEqual([
      { name: 'A', count: 12, confidence: 'good', at: 5 },
      { name: '', count: 3, confidence: 'low', at: 0 },
    ]);
    expect(parseEntries({ length: 3 })).toEqual([]);
  });

  it('starts with a usable list from damaged storage', () => {
    vi.stubGlobal('localStorage', fakeStorage({ 'stack-counter.tally.v1': '[null,{"count":"4"},{"count":4,"confidence":"good"}]' }));
    const t = new Tally();
    expect(t.total).toBe(4);
    expect(t.toText()).toBe('Stack 1\t4\nTotal\t4');
  });

  const look = (v: number) => Array.from({ length: LOOK_SIZE }, () => v);

  it('drops looks that would score NaN or have the wrong size', () => {
    const got = parseTitles([
      null,
      { name: 'Awake', looks: [look(1 / LOOK_SIZE), [...look(0).slice(1), NaN], [1, 2]] },
      { name: 'Empty', looks: [[...look(0).slice(1), null]] },
      { name: '', looks: [look(0)] },
    ]);
    expect(got.map((t) => [t.name, t.looks.length])).toEqual([['Awake', 1]]);
  });

  it('does not match every stack when storage holds a short look', () => {
    // A short look reads past its end: undefined -> NaN score, which no threshold rejects.
    const bad = { name: 'Bad', looks: [[0.5, 0.5]] };
    vi.stubGlobal('localStorage', fakeStorage({ 'stack-counter.titles.v1': JSON.stringify([null, bad]) }));
    const titles = new Titles();
    expect(titles.names()).toEqual([]);
    expect(titles.match(new Float32Array(LOOK_SIZE).fill(1 / LOOK_SIZE))).toBeNull();
    expect(titles.match(new Float32Array(LOOK_SIZE).fill(NaN))).toBeNull();
  });
});

describe('camera lifecycle', () => {
  let tracks: { stopped: boolean; stop(): void }[];
  let pending: ((s: unknown) => void)[];
  let play: () => Promise<void>;
  const video = { srcObject: null as unknown, play: () => play() } as unknown as HTMLVideoElement;

  beforeEach(() => {
    tracks = [];
    pending = [];
    play = () => Promise.resolve();
    vi.stubGlobal('navigator', {
      mediaDevices: {
        getUserMedia: () =>
          new Promise((resolve) => {
            const track = { stopped: false, stop() { this.stopped = true; } };
            tracks.push(track);
            pending.push(() => resolve({ getTracks: () => [track], getVideoTracks: () => [track] }));
          }),
      },
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  const settle = async () => {
    pending.splice(0).forEach((r) => r(undefined));
    await new Promise((r) => setTimeout(r, 0));
  };

  it('shares one request between overlapping starts', async () => {
    const cam = new Camera(video);
    const a = cam.start();
    const b = cam.start();
    await settle();
    await Promise.all([a, b]);
    expect(tracks).toHaveLength(1);
    expect(cam.running).toBe(true);
  });

  it('releases a stream that arrives after stop()', async () => {
    const cam = new Camera(video);
    const a = cam.start();
    cam.stop();
    await settle();
    await a;
    expect(cam.running).toBe(false);
    expect(tracks[0].stopped).toBe(true);
  });

  it('can start again while a stopped start is still pending', async () => {
    const cam = new Camera(video);
    void cam.start();
    cam.stop();
    const again = cam.start();
    await settle();
    await again;
    expect(cam.running).toBe(true);
    expect(tracks.map((t) => t.stopped)).toEqual([true, false]);
  });

  it('turns the camera off if the video will not play', async () => {
    play = () => Promise.reject(new Error('no'));
    const cam = new Camera(video);
    const failed = expect(cam.start()).rejects.toThrow('no');
    await settle();
    await failed;
    expect(cam.running).toBe(false);
    expect(tracks[0].stopped).toBe(true);
  });
});
