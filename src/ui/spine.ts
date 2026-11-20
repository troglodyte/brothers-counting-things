// Read the title off the spines with Tesseract (on the phone, no network once
// cached). Only used when the look doesn't match a known title. The OCR files
// (~6 MB) are self-hosted under ./tesseract-<hash>/ (see vite.config.ts) and fetched on first use.
//
// Every item in a single-title stack repeats the title, so the reading that
// recurs across rows wins; one-off fragments and spine junk lose.

import type { Line } from '../algorithm/profile';

export interface OcrWord {
  text: string;
  confidence: number;
  bbox: { x0: number; y0: number; x1: number; y1: number };
}

/**
 * Pixels handed to Tesseract: enough to read spine text, few enough to be quick
 * on a phone. Sized by area, not by the item count, so a wrong count can't
 * shrink the text out of reach.
 */
// Each photo reads best at its own size, and Tesseract is touchy about it, so
// read at several and pool the words (in source pixels) as one body of evidence.
const AREAS = [4e6, 2.5e6, 1.5e6];

type Worker = { recognize: (img: HTMLCanvasElement, o: object, out: object) => Promise<{ data: { blocks: unknown } }> };
let worker: Promise<Worker> | null = null;

function getWorker(): Promise<Worker> {
  worker ??= (async () => {
    const T = await import('tesseract.js');
    const base = new URL(__OCR_DIR__, document.baseURI).href;
    const w = await T.createWorker('eng', T.OEM.LSTM_ONLY, {
      workerPath: `${base}/worker.min.js`,
      corePath: base,
      langPath: base,
      gzip: true,
      // The service worker already caches the model; Tesseract's own IndexedDB copy
      // would be a second 2 MB and is keyed without the version.
      cacheMethod: 'none',
    });
    await w.setParameters({ tessedit_pageseg_mode: T.PSM.SPARSE_TEXT });
    return w as unknown as Worker;
  })();
  worker.catch(() => (worker = null));
  return worker;
}

/** The title read off the spines, or null. Handles stacks lying flat (line roughly vertical). */
export async function readSpine(bitmap: ImageBitmap, line: Line): Promise<string | null> {
  const dx = line.x2 - line.x1;
  const dy = line.y2 - line.y1;
  if (Math.abs(dx) > Math.abs(dy)) return null; // upright stack: the text runs vertically
  const pad = 0.05 * Math.abs(dy);
  const sy = Math.max(0, Math.floor(Math.min(line.y1, line.y2) - pad));
  const sh = Math.min(bitmap.height, Math.ceil(Math.max(line.y1, line.y2) + pad)) - sy;
  const sw = bitmap.width; // the title may be anywhere along the spine
  const w = await getWorker();
  type Block = { paragraphs: { lines: { words: OcrWord[] }[] }[] };
  const pooled: OcrWord[] = [];
  let title: string | null = null;
  for (const area of AREAS) {
    const s = Math.min(1, Math.sqrt(area / (sw * sh)));
    const { data } = await w.recognize(shrink(bitmap, 0, sy, sw, sh, s), {}, { blocks: true });
    for (const b of (data.blocks as Block[] | null) ?? [])
      for (const p of b.paragraphs)
        for (const l of p.lines)
          for (const wd of l.words) {
            const { x0, y0, x1, y1 } = wd.bbox;
            pooled.push({ ...wd, bbox: { x0: x0 / s, y0: y0 / s, x1: x1 / s, y1: y1 / s } });
          }
    title = pickTitle(pooled);
    // Stop once two sizes agree on a title; a single read is too easily a fluke.
    if (title && area !== AREAS[0]) break;
  }
  return title;
}

/**
 * Crop and scale by halving steps: one big drawImage step blurs the letters
 * badly enough that Tesseract misreads them ("Millis" for "Ministry").
 */
function shrink(src: CanvasImageSource, sx: number, sy: number, sw: number, sh: number, s: number): HTMLCanvasElement {
  let c = document.createElement('canvas');
  let scale = Math.max(s, 0.5);
  c.width = Math.max(1, Math.round(sw * scale));
  c.height = Math.max(1, Math.round(sh * scale));
  c.getContext('2d')!.drawImage(src, sx, sy, sw, sh, 0, 0, c.width, c.height);
  while (scale > s) {
    const next = Math.max(s, scale / 2);
    const d = document.createElement('canvas');
    d.width = Math.max(1, Math.round(sw * next));
    d.height = Math.max(1, Math.round(sh * next));
    const ctx = d.getContext('2d')!;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(c, 0, 0, d.width, d.height);
    c = d;
    scale = next;
  }
  return c;
}

const norm = (t: string) => t.toLowerCase().replace(/[^a-z]/g, '');
const wordy = (t: string) => t.length >= 4 && /[aeiouy]/.test(t);

/** Join words into spine rows, then pick the row whose words recur most across the stack. */
export function pickTitle(words: OcrWord[]): string | null {
  const good = words
    .filter((w) => w.confidence > 60 && /[A-Za-z]{2}/.test(w.text))
    .sort((a, b) => a.bbox.y0 - b.bbox.y0 || a.bbox.x0 - b.bbox.x0);
  const rows: { cy: number; x0: number; x1: number; words: string[] }[] = [];
  for (const w of good) {
    const h = w.bbox.y1 - w.bbox.y0;
    const cy = (w.bbox.y0 + w.bbox.y1) / 2;
    const row = rows.find((r) => Math.abs(r.cy - cy) < 0.5 * h && w.bbox.x0 > r.x0 && w.bbox.x0 - r.x1 < 2.5 * h);
    if (row) {
      // The same word read again at another size lands on the same row: keep one.
      if (!row.words.some((x) => norm(x) === norm(w.text))) row.words.push(w.text);
      row.x1 = Math.max(row.x1, w.bbox.x1);
    } else rows.push({ cy, x0: w.bbox.x0, x1: w.bbox.x1, words: [w.text] });
  }

  const freq = new Map<string, number>();
  const spelled = new Map<string, string>(); // normalised -> as read, for display
  for (const r of rows) {
    for (const w of r.words) {
      const t = norm(w);
      if (wordy(t) && !spelled.has(t)) spelled.set(t, w.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, ''));
    }
    for (const t of new Set(r.words.map(norm).filter(wordy))) freq.set(t, (freq.get(t) ?? 0) + 1);
  }

  let best: { score: number; words: string[] } | null = null;
  for (const r of rows) {
    const tokens = r.words.map(norm).filter(wordy);
    if (!tokens.some((t) => (freq.get(t) ?? 0) >= 2)) continue; // must recur on another item
    const score = tokens.reduce((s, t) => s + (freq.get(t) ?? 0), 0);
    if (score >= 3 && (!best || score > best.score)) best = { score, words: r.words };
  }
  if (!best) return null;
  // A cut-off word ("istry") becomes the fuller reading from another item ("Ministry").
  const fuller = (t: string) =>
    [...freq.keys()]
      .filter((k) => k.length > t.length && (k.startsWith(t) || k.endsWith(t)))
      .sort((a, b) => b.length - a.length)[0];
  const text = best.words
    .map((w) => {
      const t = norm(w);
      const f = t.length >= 3 ? fuller(t) : undefined;
      return f ? spelled.get(f)! : w.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, '');
    })
    .filter((w) => /[A-Za-z]{2}/.test(w))
    // Spines often print the title twice along their length; keep each word once.
    .filter((w, i, all) => all.findIndex((x) => norm(x) === norm(w)) === i)
    .join(' ');
  return text || null;
}

/** A known name the OCR text is (nearly) the same as, or contained in. */
export function closestName(text: string, names: string[]): string | null {
  const t = norm(text);
  if (t.length < 4) return null;
  let best: { name: string; d: number } | null = null;
  for (const name of names) {
    const n = norm(name);
    if (!n) continue;
    const d = n.includes(t) || t.includes(n) ? 0 : levenshtein(t, n) / Math.max(t.length, n.length);
    if (d <= 0.25 && (!best || d < best.d)) best = { name, d };
  }
  return best?.name ?? null;
}

function levenshtein(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}
