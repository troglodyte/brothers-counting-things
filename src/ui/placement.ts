// Screen 2: pinch-zoom the photo, tap the first and last item, drag either
// endpoint to adjust. A loupe shows the full-resolution pixels under the
// finger so an endpoint lands within an item or two.

import Panzoom, { type PanzoomObject } from '@panzoom/panzoom';
import type { Point } from '../algorithm/profile';

const HANDLE_HIT = 30; // css px
const TAP_SLOP = 10; // css px
const TAP_MS = 450;
const LOUPE = 150; // css px

export class Placement {
  points: Point[] = [];

  private pz: PanzoomObject;
  private overlay = document.createElement('canvas');
  private loupe = document.createElement('canvas');
  private pointers = new Set<number>();
  private tap: { id: number; x: number; y: number; t: number } | null = null;
  private drag: { index: number; pointer: number } | null = null;
  private loupeTimer = 0;
  private cleanups: (() => void)[] = [];
  private resizeObs: ResizeObserver;

  constructor(
    private stage: HTMLElement,
    private bitmap: ImageBitmap,
    private view: HTMLCanvasElement,
    private onChange: (points: Point[]) => void,
    initial: Point[] = [],
  ) {
    this.points = initial.map((p) => ({ ...p }));
    this.overlay.className = 'overlay';
    this.loupe.className = 'loupe';
    this.loupe.hidden = true;
    stage.replaceChildren(view, this.overlay, this.loupe);

    this.fitView();
    this.pz = Panzoom(view, {
      canvas: true,
      maxScale: 40,
      minScale: 1,
      step: 0.4,
      cursor: 'default',
    });

    const onWheel = (e: WheelEvent) => this.pz.zoomWithWheel(e);
    const onPz = () => this.draw();
    stage.addEventListener('wheel', onWheel, { passive: false });
    view.addEventListener('panzoomchange', onPz);
    // Capture phase so a handle grab is seen before Panzoom starts panning.
    stage.addEventListener('pointerdown', this.onDown, { capture: true });
    window.addEventListener('pointermove', this.onMove, { passive: false });
    window.addEventListener('pointerup', this.onUp);
    window.addEventListener('pointercancel', this.onUp);
    this.cleanups.push(
      () => stage.removeEventListener('wheel', onWheel),
      () => view.removeEventListener('panzoomchange', onPz),
      () => stage.removeEventListener('pointerdown', this.onDown, { capture: true }),
      () => window.removeEventListener('pointermove', this.onMove),
      () => window.removeEventListener('pointerup', this.onUp),
      () => window.removeEventListener('pointercancel', this.onUp),
    );

    this.resizeObs = new ResizeObserver(() => {
      this.fitView();
      this.draw();
    });
    this.resizeObs.observe(stage);
    requestAnimationFrame(() => this.draw());
  }

  destroy(): void {
    this.resizeObs.disconnect();
    for (const c of this.cleanups) c();
    this.pz.destroy();
    clearTimeout(this.loupeTimer);
  }

  clear(): void {
    this.points = [];
    this.draw();
    this.onChange(this.points);
  }

  resetZoom(): void {
    this.pz.reset({ animate: false });
  }

  /** Size the view canvas to fit the stage ("contain"); Panzoom transforms from there. */
  private fitView(): void {
    const r = this.stage.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return;
    const s = Math.min(r.width / this.view.width, r.height / this.view.height);
    this.view.style.width = `${this.view.width * s}px`;
    this.view.style.height = `${this.view.height * s}px`;
    const dpr = window.devicePixelRatio || 1;
    this.overlay.width = Math.round(r.width * dpr);
    this.overlay.height = Math.round(r.height * dpr);
    this.overlay.style.width = `${r.width}px`;
    this.overlay.style.height = `${r.height}px`;
  }

  private clientToImage(cx: number, cy: number): Point {
    const r = this.view.getBoundingClientRect();
    const x = ((cx - r.left) / r.width) * this.bitmap.width;
    const y = ((cy - r.top) / r.height) * this.bitmap.height;
    return {
      x: Math.max(0, Math.min(this.bitmap.width - 1, x)),
      y: Math.max(0, Math.min(this.bitmap.height - 1, y)),
    };
  }

  private imageToStage(p: Point): Point {
    const r = this.view.getBoundingClientRect();
    const s = this.stage.getBoundingClientRect();
    return {
      x: r.left - s.left + (p.x / this.bitmap.width) * r.width,
      y: r.top - s.top + (p.y / this.bitmap.height) * r.height,
    };
  }

  private hitHandle(cx: number, cy: number): number | null {
    const s = this.stage.getBoundingClientRect();
    let best: number | null = null;
    let bestD = HANDLE_HIT;
    this.points.forEach((p, i) => {
      const q = this.imageToStage(p);
      const d = Math.hypot(q.x - (cx - s.left), q.y - (cy - s.top));
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    return best;
  }

  private onDown = (e: PointerEvent): void => {
    this.pointers.add(e.pointerId);
    if (this.pointers.size > 1) {
      // Second finger: this is a pinch, not a tap.
      this.tap = null;
      return;
    }
    const hit = this.hitHandle(e.clientX, e.clientY);
    if (hit !== null) {
      e.stopImmediatePropagation();
      e.preventDefault();
      this.drag = { index: hit, pointer: e.pointerId };
      this.pz.setOptions({ disablePan: true, disableZoom: true });
      this.showLoupe(e.clientX, e.clientY, this.points[hit]);
      return;
    }
    this.tap = { id: e.pointerId, x: e.clientX, y: e.clientY, t: performance.now() };
  };

  private onMove = (e: PointerEvent): void => {
    if (this.drag && e.pointerId === this.drag.pointer) {
      e.preventDefault();
      const p = this.clientToImage(e.clientX, e.clientY);
      this.points[this.drag.index] = p;
      this.draw();
      this.showLoupe(e.clientX, e.clientY, p);
      return;
    }
    if (this.tap && e.pointerId === this.tap.id && Math.hypot(e.clientX - this.tap.x, e.clientY - this.tap.y) > TAP_SLOP) {
      this.tap = null;
    }
  };

  private onUp = (e: PointerEvent): void => {
    this.pointers.delete(e.pointerId);
    if (this.drag && e.pointerId === this.drag.pointer) {
      this.drag = null;
      this.pz.setOptions({ disablePan: false, disableZoom: false });
      this.hideLoupe(0);
      this.onChange(this.points);
      return;
    }
    const tap = this.tap;
    this.tap = null;
    if (!tap || e.pointerId !== tap.id || e.type !== 'pointerup') return;
    if (performance.now() - tap.t > TAP_MS) return;
    if (this.points.length >= 2) return; // adjust by dragging; "Clear line" to start over
    const p = this.clientToImage(e.clientX, e.clientY);
    this.points.push(p);
    this.draw();
    this.showLoupe(e.clientX, e.clientY, p);
    this.hideLoupe(700);
    this.onChange(this.points);
  };

  private showLoupe(cx: number, cy: number, p: Point): void {
    clearTimeout(this.loupeTimer);
    const dpr = window.devicePixelRatio || 1;
    const size = LOUPE;
    const c = this.loupe;
    if (c.width !== size * dpr) {
      c.width = size * dpr;
      c.height = size * dpr;
      c.style.width = `${size}px`;
      c.style.height = `${size}px`;
    }
    const s = this.stage.getBoundingClientRect();
    let left = cx - s.left - size / 2;
    let top = cy - s.top - size / 2 - 110;
    if (top < 4) top = cy - s.top + 60;
    left = Math.max(4, Math.min(s.width - size - 4, left));
    c.style.transform = `translate(${left}px, ${top}px)`;
    c.hidden = false;

    // Show a region a few times more magnified than the current view.
    const r = this.view.getBoundingClientRect();
    const screenPerImage = r.width / this.bitmap.width;
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
    ctx.moveTo(m - 18 * dpr, m);
    ctx.lineTo(m - 5 * dpr, m);
    ctx.moveTo(m + 5 * dpr, m);
    ctx.lineTo(m + 18 * dpr, m);
    ctx.moveTo(m, m - 18 * dpr);
    ctx.lineTo(m, m - 5 * dpr);
    ctx.moveTo(m, m + 5 * dpr);
    ctx.lineTo(m, m + 18 * dpr);
    ctx.stroke();
    ctx.restore();
  }

  private hideLoupe(delayMs: number): void {
    clearTimeout(this.loupeTimer);
    if (delayMs <= 0) this.loupe.hidden = true;
    else this.loupeTimer = window.setTimeout(() => (this.loupe.hidden = true), delayMs);
  }

  draw(): void {
    const c = this.overlay;
    const ctx = c.getContext('2d')!;
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const pts = this.points.map((p) => this.imageToStage(p));
    if (pts.length === 2) {
      ctx.lineCap = 'round';
      ctx.strokeStyle = 'rgba(0,0,0,0.7)';
      ctx.lineWidth = 5;
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      ctx.lineTo(pts[1].x, pts[1].y);
      ctx.stroke();
      ctx.strokeStyle = '#ffcc33';
      ctx.lineWidth = 2.5;
      ctx.stroke();
    }
    pts.forEach((q, i) => {
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(0,0,0,0.7)';
      ctx.beginPath();
      ctx.arc(q.x, q.y, 16, 0, Math.PI * 2);
      ctx.stroke();
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#ffcc33';
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(q.x, q.y, 2.5, 0, Math.PI * 2);
      ctx.fillStyle = '#ffcc33';
      ctx.fill();
      ctx.font = 'bold 13px system-ui, sans-serif';
      ctx.fillStyle = '#ffcc33';
      ctx.fillText(i === 0 ? 'first' : 'last', q.x + 20, q.y + 4);
    });
  }
}
