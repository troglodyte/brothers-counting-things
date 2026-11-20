// Line placement on the frozen photo. One finger drags a line from the first
// item to the last; dragging a handle adjusts that end; two fingers pinch-zoom
// and pan. A loupe shows full-resolution pixels under the finger, and onChange
// fires while dragging (live = true) and again on release (live = false) so the
// count can follow the finger.
//
// Gestures are handled here rather than by a pan/zoom library because a
// one-finger drag must draw, not pan.

import type { Point } from '../algorithm/profile';

const HANDLE_HIT = 32; // css px
const DRAG_SLOP = 8; // css px before a touch counts as drawing
const LOUPE = 150; // css px
const MAX_ZOOM = 40;

export type Mode =
  | { kind: 'none' }
  | { kind: 'handle'; index: number; pointer: number }
  | { kind: 'draw'; pointer: number; start: Point; startClient: { x: number; y: number }; before: Point[]; moved: boolean }
  | { kind: 'pinch'; mid0: { x: number; y: number }; dist0: number; k0: number; tx0: number; ty0: number };

/** view canvas px -> stage css px: stage = t + k * view; kFit is the whole-photo zoom. */
export interface ViewState {
  k: number;
  kFit: number;
  tx: number;
  ty: number;
}

/** The whole photo, centred in the stage. */
export function fitView(stageW: number, stageH: number, viewW: number, viewH: number): ViewState {
  const k = Math.min(stageW / viewW, stageH / viewH);
  return { k, kFit: k, tx: (stageW - viewW * k) / 2, ty: (stageH - viewH * k) / 2 };
}

/**
 * The view after the stage resizes. During a gesture: null, meaning leave the
 * photo where it is under the finger and call again when the gesture ends.
 * Otherwise an un-zoomed photo is refitted and a zoomed one stays put.
 */
export function viewAfterResize(cur: ViewState, fit: ViewState, gestureActive: boolean): ViewState | null {
  if (gestureActive) return null;
  const zoomed = cur.k > cur.kFit * (1 + 1e-9);
  if (!zoomed || cur.k <= fit.kFit) return fit;
  return { ...cur, kFit: fit.kFit };
}

/**
 * The line to keep when a second finger turns a one-finger gesture into a
 * pinch, or null if nothing changed. A line being drawn is abandoned (back to
 * the one before it); a handle being dragged stays where it was moved to.
 * Either way the caller recounts, or the count shown and saved would be for a
 * line that is no longer on screen.
 */
export function pinchTakeover(mode: Mode, points: Point[]): Point[] | null {
  if (mode.kind === 'draw') return mode.moved ? mode.before : null;
  if (mode.kind === 'handle') return points;
  return null;
}

export class Placement {
  points: Point[] = [];

  private overlay = document.createElement('canvas');
  private loupe = document.createElement('canvas');
  private pointers = new Map<number, { x: number; y: number }>();
  private mode: Mode = { kind: 'none' };
  private ticks: Point[] = [];
  /** view canvas px -> stage css px: stage = t + k * view */
  private k = 1;
  private kFit = 1;
  private tx = 0;
  private ty = 0;
  private resizePending = false;
  private cleanups: (() => void)[] = [];
  private resizeObs: ResizeObserver;

  constructor(
    private stage: HTMLElement,
    private bitmap: ImageBitmap,
    private view: HTMLCanvasElement,
    private onChange: (points: Point[], live: boolean) => void,
  ) {
    this.overlay.className = 'overlay';
    this.loupe.className = 'loupe';
    this.loupe.hidden = true;
    view.style.width = `${view.width}px`;
    view.style.height = `${view.height}px`;
    stage.replaceChildren(view, this.overlay, this.loupe);

    const listen = <K extends keyof HTMLElementEventMap>(
      target: HTMLElement | Window,
      type: K,
      fn: (e: HTMLElementEventMap[K]) => void,
      opts?: AddEventListenerOptions,
    ) => {
      target.addEventListener(type, fn as EventListener, opts);
      this.cleanups.push(() => target.removeEventListener(type, fn as EventListener, opts));
    };
    listen(stage, 'pointerdown', this.onDown);
    listen(window, 'pointermove', this.onMove, { passive: false });
    listen(window, 'pointerup', this.onUp);
    listen(window, 'pointercancel', this.onUp);
    listen(stage, 'wheel', this.onWheel, { passive: false });

    this.resizeObs = new ResizeObserver(() => this.onResize());
    this.resizeObs.observe(stage);
    this.fit();
  }

  destroy(): void {
    this.resizeObs.disconnect();
    for (const c of this.cleanups) c();
    // Let go of the photo-sized canvas now rather than at the next photo.
    this.stage.replaceChildren();
    this.view.width = this.view.height = 0;
  }

  /** Tick marks (image coordinates) drawn across the line, one per detected item. */
  setTicks(ticks: Point[]): void {
    this.ticks = ticks;
    this.draw();
  }

  // ---- view transform ----

  private fit(): void {
    const r = this.stage.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return;
    this.sizeOverlay(r);
    this.setView(fitView(r.width, r.height, this.view.width, this.view.height));
  }

  /**
   * The stage changes size when the bar below it grows (the first live count
   * shows the badge). Refitting then would move and rescale the photo under a
   * finger that is still drawing, so the line's end lands on the wrong item.
   */
  private onResize(): void {
    const r = this.stage.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return;
    this.sizeOverlay(r);
    const next = viewAfterResize(
      { k: this.k, kFit: this.kFit, tx: this.tx, ty: this.ty },
      fitView(r.width, r.height, this.view.width, this.view.height),
      this.mode.kind !== 'none',
    );
    this.resizePending = next === null;
    if (next) this.setView(next);
    else this.draw();
  }

  private endGesture(): void {
    this.mode = { kind: 'none' };
    if (this.resizePending) this.onResize();
  }

  private sizeOverlay(r: DOMRect): void {
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(r.width * dpr);
    const h = Math.round(r.height * dpr);
    if (this.overlay.width !== w) this.overlay.width = w;
    if (this.overlay.height !== h) this.overlay.height = h;
    this.overlay.style.width = `${r.width}px`;
    this.overlay.style.height = `${r.height}px`;
  }

  private setView(v: ViewState): void {
    this.k = v.k;
    this.kFit = v.kFit;
    this.tx = v.tx;
    this.ty = v.ty;
    this.apply();
  }

  private apply(): void {
    this.view.style.transform = `translate(${this.tx}px, ${this.ty}px) scale(${this.k})`;
    this.draw();
  }

  private zoomAbout(sx: number, sy: number, k: number, from = { k: this.k, tx: this.tx, ty: this.ty }): void {
    k = Math.max(this.kFit, Math.min(this.kFit * MAX_ZOOM, k));
    const vx = (sx - from.tx) / from.k;
    const vy = (sy - from.ty) / from.k;
    this.k = k;
    this.tx = sx - vx * k;
    this.ty = sy - vy * k;
    if (k === this.kFit) this.fit();
    else this.apply();
  }

  private stageXY(cx: number, cy: number): { x: number; y: number } {
    const s = this.stage.getBoundingClientRect();
    return { x: cx - s.left, y: cy - s.top };
  }

  private clientToImage(cx: number, cy: number): Point {
    const { x: sx, y: sy } = this.stageXY(cx, cy);
    const toImg = this.bitmap.width / this.view.width;
    const x = ((sx - this.tx) / this.k) * toImg;
    const y = ((sy - this.ty) / this.k) * toImg;
    return {
      x: Math.max(0, Math.min(this.bitmap.width - 1, x)),
      y: Math.max(0, Math.min(this.bitmap.height - 1, y)),
    };
  }

  private imageToStage(p: Point): Point {
    const toView = this.view.width / this.bitmap.width;
    return { x: this.tx + p.x * toView * this.k, y: this.ty + p.y * toView * this.k };
  }

  private hitHandle(cx: number, cy: number): number | null {
    const s = this.stageXY(cx, cy);
    let best: number | null = null;
    let bestD = HANDLE_HIT;
    this.points.forEach((p, i) => {
      const q = this.imageToStage(p);
      const d = Math.hypot(q.x - s.x, q.y - s.y);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    return best;
  }

  // ---- gestures ----

  private onDown = (e: PointerEvent): void => {
    e.preventDefault();
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this.pointers.size === 2) {
      // Second finger: end the one-finger gesture and pinch instead. The count
      // must then be redone for whatever line is left on screen.
      const settle = pinchTakeover(this.mode, this.points);
      if (settle) {
        this.points = settle;
        this.changed(false);
      }
      this.hideLoupe();
      const [a, b] = [...this.pointers.values()];
      this.mode = {
        kind: 'pinch',
        mid0: this.stageXY((a.x + b.x) / 2, (a.y + b.y) / 2),
        dist0: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
        k0: this.k,
        tx0: this.tx,
        ty0: this.ty,
      };
      return;
    }
    if (this.pointers.size > 2) return;
    const hit = this.hitHandle(e.clientX, e.clientY);
    if (hit !== null) {
      this.mode = { kind: 'handle', index: hit, pointer: e.pointerId };
      this.showLoupe(e.clientX, e.clientY, this.points[hit]);
      return;
    }
    const start = this.clientToImage(e.clientX, e.clientY);
    this.mode = {
      kind: 'draw',
      pointer: e.pointerId,
      start,
      startClient: { x: e.clientX, y: e.clientY },
      before: this.points,
      moved: false,
    };
    this.showLoupe(e.clientX, e.clientY, start);
  };

  private onMove = (e: PointerEvent): void => {
    if (!this.pointers.has(e.pointerId)) return;
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const m = this.mode;
    if (m.kind === 'pinch') {
      e.preventDefault();
      if (this.pointers.size < 2) return;
      const [a, b] = [...this.pointers.values()];
      const mid = this.stageXY((a.x + b.x) / 2, (a.y + b.y) / 2);
      const dist = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
      // Zoom about the starting midpoint, then follow the midpoint (pan).
      const k = Math.max(this.kFit, Math.min(this.kFit * MAX_ZOOM, (m.k0 * dist) / m.dist0));
      const vx = (m.mid0.x - m.tx0) / m.k0;
      const vy = (m.mid0.y - m.ty0) / m.k0;
      this.k = k;
      this.tx = mid.x - vx * k;
      this.ty = mid.y - vy * k;
      this.apply();
      return;
    }
    if (m.kind === 'handle' && e.pointerId === m.pointer) {
      e.preventDefault();
      const p = this.clientToImage(e.clientX, e.clientY);
      this.points = this.points.map((q, i) => (i === m.index ? p : q));
      this.showLoupe(e.clientX, e.clientY, p);
      this.changed(true);
      return;
    }
    if (m.kind === 'draw' && e.pointerId === m.pointer) {
      e.preventDefault();
      if (!m.moved && Math.hypot(e.clientX - m.startClient.x, e.clientY - m.startClient.y) < DRAG_SLOP) return;
      m.moved = true;
      const p = this.clientToImage(e.clientX, e.clientY);
      this.points = [m.start, p];
      this.ticks = [];
      this.showLoupe(e.clientX, e.clientY, p);
      this.changed(true);
    }
  };

  private onUp = (e: PointerEvent): void => {
    if (!this.pointers.delete(e.pointerId)) return;
    const m = this.mode;
    if (m.kind === 'pinch') {
      // Lifting one finger of a pinch must not start a line with the other.
      if (this.pointers.size === 0) this.endGesture();
      return;
    }
    if ((m.kind === 'handle' || m.kind === 'draw') && e.pointerId === m.pointer) {
      this.endGesture();
      this.hideLoupe();
      if (m.kind === 'handle' || m.moved) this.changed(false);
    }
  };

  private onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    const s = this.stageXY(e.clientX, e.clientY);
    this.zoomAbout(s.x, s.y, this.k * Math.exp(-e.deltaY * 0.0015));
  };

  private changed(live: boolean): void {
    this.draw();
    this.onChange(this.points, live);
  }

  // ---- drawing ----

  private showLoupe(cx: number, cy: number, p: Point): void {
    const dpr = window.devicePixelRatio || 1;
    const size = LOUPE;
    const c = this.loupe;
    if (c.width !== size * dpr) {
      c.width = size * dpr;
      c.height = size * dpr;
      c.style.width = `${size}px`;
      c.style.height = `${size}px`;
    }
    const s = this.stageXY(cx, cy);
    const r = this.stage.getBoundingClientRect();
    let left = s.x - size / 2;
    let top = s.y - size / 2 - 110;
    if (top < 4) top = s.y + 60;
    left = Math.max(4, Math.min(r.width - size - 4, left));
    c.style.transform = `translate(${left}px, ${top}px)`;
    c.hidden = false;

    // A region a few times more magnified than the current view.
    const screenPerImage = (this.k * this.view.width) / this.bitmap.width;
    const radius = Math.max(6, Math.min(60, 25 / screenPerImage));
    const ctx = c.getContext('2d')!;
    ctx.save();
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.beginPath();
    ctx.arc(c.width / 2, c.height / 2, c.width / 2, 0, Math.PI * 2);
    ctx.clip();
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(this.bitmap, p.x - radius, p.y - radius, 2 * radius, 2 * radius, 0, 0, c.width, c.height);
    const m = c.width / 2;
    ctx.strokeStyle = 'rgba(255, 204, 51, 0.95)';
    ctx.lineWidth = 1.5 * dpr;
    ctx.beginPath();
    for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
      ctx.moveTo(m + dx * 5 * dpr, m + dy * 5 * dpr);
      ctx.lineTo(m + dx * 18 * dpr, m + dy * 18 * dpr);
    }
    ctx.stroke();
    ctx.restore();
  }

  private hideLoupe(): void {
    this.loupe.hidden = true;
  }

  draw(): void {
    const c = this.overlay;
    const ctx = c.getContext('2d')!;
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (this.points.length < 2) return;
    const [a, b] = this.points.map((p) => this.imageToStage(p));
    ctx.lineCap = 'round';
    ctx.strokeStyle = 'rgba(0,0,0,0.7)';
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
    ctx.strokeStyle = '#ffcc33';
    ctx.lineWidth = 2.5;
    ctx.stroke();

    // Ticks across the line, alternating colour so neighbours stay distinct.
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const nx = -(b.y - a.y) / len;
    const ny = (b.x - a.x) / len;
    const half = 11;
    ctx.lineWidth = 2;
    this.ticks.forEach((t, i) => {
      const q = this.imageToStage(t);
      ctx.strokeStyle = i % 2 ? '#ff4fd8' : '#4fe3ff';
      ctx.beginPath();
      ctx.moveTo(q.x - nx * half, q.y - ny * half);
      ctx.lineTo(q.x + nx * half, q.y + ny * half);
      ctx.stroke();
    });

    [a, b].forEach((q) => {
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(0,0,0,0.7)';
      ctx.beginPath();
      ctx.arc(q.x, q.y, 16, 0, Math.PI * 2);
      ctx.stroke();
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#ffcc33';
      ctx.stroke();
    });
  }
}
