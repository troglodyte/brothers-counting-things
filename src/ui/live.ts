// Live mode: count the stack under a fixed guide line in the viewfinder, a few
// times a second, without a photo or a drawn line. The shutter then opens the
// photo screen with the line already on the found ends (see main.ts).

import { findEnds, guideLine, subLine } from '../algorithm/autoends';
import { countStrip, DEFAULTS, type CountOptions, type CountResult } from '../algorithm/count';
import { stripGeometry, toGray, type Line } from '../algorithm/profile';
import { straightenStrip } from './capture';
import { Settler, type Settled } from './settle';

export interface AutoCount {
  guide: Line;
  /** First item centre to last item centre, in source pixels. */
  line: Line;
  result: CountResult;
  /** `result.count` and `result.confidence`, for the Settler. */
  count: number;
  confidence: CountResult['confidence'];
}

/**
 * Find the stack on the guide line of a w x h source (a photo, or the video's
 * current frame) and count it as if the user had drawn the found line.
 */
export function autoCount(src: ImageBitmap | HTMLVideoElement, w: number, h: number, opts: CountOptions = {}): AutoCount | null {
  const guide = guideLine(w, h);
  const geom = stripGeometry(guide, DEFAULTS.stripHalfHeight);
  const ends = findEnds(straightenStrip(src, guide, geom).image, geom);
  if (!ends) return null;
  const line = subLine(guide, ends);
  const g2 = stripGeometry(line, DEFAULTS.stripHalfHeight);
  const result = countStrip(toGray(straightenStrip(src, line, g2).image), g2, opts);
  return result.count === null ? null : { guide, line, result, count: result.count, confidence: result.confidence };
}

/** Pause between counts. One count takes ~20-40 ms on a phone; this keeps the camera smooth. */
const INTERVAL_MS = 150;

export class LiveView {
  private on = false;
  private timer = 0;
  private settler = new Settler<AutoCount>();

  constructor(
    private video: HTMLVideoElement,
    private overlay: HTMLCanvasElement,
    private readout: HTMLElement,
    private opts: () => CountOptions,
  ) {}

  start(): void {
    if (this.on) return;
    this.on = true;
    this.settler.reset();
    this.overlay.hidden = false;
    this.readout.hidden = false;
    this.tick();
  }

  stop(): void {
    this.on = false;
    clearTimeout(this.timer);
    this.overlay.hidden = true;
    this.readout.hidden = true;
  }

  /** The count most recent frames agree on (null: no stack under the guide). */
  settled(): Settled<AutoCount> | null {
    return this.on ? this.settler.settled() : null;
  }

  private tick = (): void => {
    if (!this.on) return;
    const v = this.video;
    if (v.videoWidth > 0 && v.readyState >= 2) {
      let found: AutoCount | null = null;
      try {
        found = autoCount(v, v.videoWidth, v.videoHeight, this.opts());
      } catch {
        // A frame that cannot be read (stream restarting): skip it.
      }
      this.settler.push(found, performance.now());
      this.draw(guideLine(v.videoWidth, v.videoHeight), this.settler.settled());
    }
    this.timer = window.setTimeout(this.tick, INTERVAL_MS);
  };

  private draw(guide: Line, found: Settled<AutoCount> | null): void {
    const v = this.video;
    const c = this.overlay;
    const dpr = window.devicePixelRatio || 1;
    const cw = c.clientWidth;
    const ch = c.clientHeight;
    if (c.width !== Math.round(cw * dpr) || c.height !== Math.round(ch * dpr)) {
      c.width = Math.round(cw * dpr);
      c.height = Math.round(ch * dpr);
    }
    const ctx = c.getContext('2d')!;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, c.width, c.height);
    // The video is shown with object-fit: contain.
    const s = Math.min(cw / v.videoWidth, ch / v.videoHeight);
    const ox = (cw - v.videoWidth * s) / 2;
    const oy = (ch - v.videoHeight * s) / 2;
    ctx.setTransform(dpr * s, 0, 0, dpr * s, dpr * ox, dpr * oy);
    const px = 1 / s; // one CSS pixel, in video pixels

    const stroke = (l: Line, colour: string, width: number, dash: number[] = []) => {
      ctx.setLineDash(dash.map((d) => d * px));
      ctx.lineWidth = width * px;
      ctx.strokeStyle = colour;
      ctx.beginPath();
      ctx.moveTo(l.x1, l.y1);
      ctx.lineTo(l.x2, l.y2);
      ctx.stroke();
    };
    ctx.lineCap = 'round';
    stroke(guide, 'rgba(0,0,0,0.5)', 4);
    stroke(guide, 'rgba(255,255,255,0.8)', 2, [8, 8]);

    if (!found) {
      this.readout.textContent = '';
      this.readout.className = 'live-readout';
      return;
    }
    // The steadied line, with the ticks of the newest frame that agrees with it.
    const { line } = found;
    stroke(line, 'rgba(0,0,0,0.7)', 6);
    stroke(line, '#ffcc33', 3);
    // Bars across the line at the two end items, and the ticks between.
    const L = Math.hypot(line.x2 - line.x1, line.y2 - line.y1) || 1;
    const ux = (line.x2 - line.x1) / L;
    const uy = (line.y2 - line.y1) / L;
    const bar = (x: number, y: number, half: number, colour: string, width: number) =>
      stroke({ x1: x + uy * half, y1: y - ux * half, x2: x - uy * half, y2: y + ux * half }, colour, width);
    const { line: tl, result } = found.latest;
    const m = result.geometry.margin;
    const tL = Math.hypot(tl.x2 - tl.x1, tl.y2 - tl.y1) || 1;
    result.ticks.forEach((u, i) => {
      const t = ((u - m) / tL) * L;
      bar(line.x1 + t * ux, line.y1 + t * uy, 9 * px, i % 2 ? '#ff4fd8' : '#4fe3ff', 2);
    });
    bar(line.x1, line.y1, 22 * px, '#ffcc33', 4);
    bar(line.x2, line.y2, 22 * px, '#ffcc33', 4);

    this.readout.textContent = String(found.count);
    this.readout.className = `live-readout ${found.confidence}${found.steady ? '' : ' settling'}`;
  }
}
