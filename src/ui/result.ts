// The count under the photo: the number and a confidence badge, updated live
// while the line is dragged; on release, the cross-check, warnings and the
// straightened strip with detected ticks (in Details) for debugging.

import type { CountResult } from '../algorithm/count';

const BADGE_TEXT = {
  good: 'Good',
  check: 'Check',
  low: 'Low confidence',
} as const;

export interface ResultEls {
  count: HTMLElement;
  badge: HTMLElement;
  hint: HTMLElement;
  cross: HTMLElement;
  warnings: HTMLElement;
  strip: HTMLElement;
}

/** Cheap enough to run on every animation frame while dragging. */
export function renderSummary(els: ResultEls, r: CountResult | null): void {
  if (!r) {
    els.count.textContent = '–';
    els.badge.hidden = true;
    els.hint.textContent = 'Drag from the first item to the last.';
    return;
  }
  els.count.textContent = r.count === null ? '?' : String(r.count);
  els.badge.hidden = false;
  els.badge.className = `badge ${r.confidence}`;
  els.badge.textContent = BADGE_TEXT[r.confidence];
  els.hint.textContent =
    r.warnings[0] ?? 'Drag an end to adjust, or drag anew to redo.';
}

/** On release: the detail that is too slow or too noisy to redraw live. */
export function renderDetails(els: ResultEls, r: CountResult, stripCanvas: HTMLCanvasElement): void {
  const parts: string[] = [];
  if (r.periodCount !== null) parts.push(`by spacing ${r.periodCount}`);
  if (r.peakCount !== null) parts.push(`by edges ${r.peakCount}`);
  if (r.pxPerItem !== null) parts.push(`${r.pxPerItem.toFixed(1)} px per item`);
  els.cross.textContent = parts.join(' · ');

  els.warnings.replaceChildren(
    ...r.warnings.map((w) => {
      const li = document.createElement('li');
      li.textContent = w;
      return li;
    }),
  );

  els.strip.replaceChildren(drawStrip(r, stripCanvas));
  els.strip.scrollLeft = 0;
}

/** Strip image scaled so each item is at least ~6 css px wide, with ticks above and below. */
function drawStrip(r: CountResult, strip: HTMLCanvasElement): HTMLCanvasElement {
  const g = r.geometry;
  const ppi = r.pxPerItem ?? 6;
  const maxWidthPx = 16000;
  let scale = Math.max(0.5, Math.min(4, 6 / ppi));
  scale = Math.min(scale, maxWidthPx / strip.width);
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const tickBand = 12;
  const cssW = strip.width * scale;
  const imgH = Math.min(strip.height * Math.max(1, scale), 120);
  const cssH = imgH + 2 * tickBand;

  const c = document.createElement('canvas');
  const bufScale = Math.min(dpr, maxWidthPx / cssW);
  c.width = Math.max(1, Math.round(cssW * bufScale));
  c.height = Math.round(cssH * bufScale);
  c.style.width = `${cssW}px`;
  c.style.height = `${cssH}px`;
  const ctx = c.getContext('2d')!;
  ctx.scale(bufScale, bufScale);
  ctx.fillStyle = '#0b0d10';
  ctx.fillRect(0, 0, cssW, cssH);
  ctx.imageSmoothingEnabled = scale < 1;
  ctx.drawImage(strip, 0, 0, strip.width, strip.height, 0, tickBand, cssW, imgH);

  // Endpoints of the line.
  ctx.fillStyle = 'rgba(255, 204, 51, 0.9)';
  for (const u of [g.margin, g.margin + g.length]) ctx.fillRect(u * scale - 1, 0, 2, cssH);

  // Ticks, alternating colour so neighbours are distinguishable when dense.
  r.ticks.forEach((u, i) => {
    ctx.fillStyle = i % 2 ? '#ff4fd8' : '#4fe3ff';
    const x = u * scale;
    ctx.fillRect(x - 0.75, 1, 1.5, tickBand - 3);
    ctx.fillRect(x - 0.75, tickBand + imgH + 2, 1.5, tickBand - 3);
  });
  return c;
}
