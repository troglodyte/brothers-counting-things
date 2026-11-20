import './style.css';
import { countStrip, DEFAULTS, type CountOptions, type CountResult } from './algorithm/count';
import { stripGeometry, toGray, type Line, type Point } from './algorithm/profile';
import { decodePhoto, makeViewCanvas, straightenStrip } from './ui/capture';
import { Placement } from './ui/placement';
import { renderResult } from './ui/result';

type ScreenName = 'capture' | 'place' | 'result';

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as T;
};

const screens: Record<ScreenName, HTMLElement> = {
  capture: $('screen-capture'),
  place: $('screen-place'),
  result: $('screen-result'),
};

const els = {
  camera: $<HTMLInputElement>('input-camera'),
  gallery: $<HTMLInputElement>('input-gallery'),
  captureError: $('capture-error'),
  stage: $('stage'),
  hint: $('place-hint'),
  placeBack: $<HTMLButtonElement>('btn-place-back'),
  placeReset: $<HTMLButtonElement>('btn-place-reset'),
  placeCount: $<HTMLButtonElement>('btn-place-count'),
  adjust: $<HTMLButtonElement>('btn-adjust'),
  newPhoto: $<HTMLButtonElement>('btn-new'),
  recount: $<HTMLButtonElement>('btn-recount'),
  invert: $<HTMLInputElement>('set-invert'),
  band: $<HTMLInputElement>('set-band'),
  bandValue: $('set-band-value'),
  devTools: $('dev-tools'),
  devTrue: $<HTMLInputElement>('dev-true'),
  copyAnnotation: $<HTMLButtonElement>('btn-copy-annotation'),
  annotation: $<HTMLTextAreaElement>('dev-annotation'),
  result: {
    count: $('result-count'),
    badge: $('result-badge'),
    cross: $('result-cross'),
    warnings: $('result-warnings'),
    strip: $('strip-scroll'),
  },
};

const state: {
  bitmap: ImageBitmap | null;
  fileName: string;
  placement: Placement | null;
  points: Point[];
  settings: Required<Pick<CountOptions, 'invert' | 'bandHalfWidth'>>;
  last: { line: Line; result: CountResult } | null;
} = {
  bitmap: null,
  fileName: '',
  placement: null,
  points: [],
  settings: { invert: DEFAULTS.invert, bandHalfWidth: DEFAULTS.bandHalfWidth },
  last: null,
};

if (new URLSearchParams(location.search).has('dev')) els.devTools.hidden = false;

// ---- Navigation (Android back button steps back through the screens) ----

function show(name: ScreenName, push = true): void {
  for (const [k, el] of Object.entries(screens)) el.hidden = k !== name;
  if (push && history.state?.screen !== name) history.pushState({ screen: name }, '');
  window.scrollTo(0, 0);
}

history.replaceState({ screen: 'capture' }, '');
window.addEventListener('popstate', (e) => {
  const want = (e.state?.screen as ScreenName | undefined) ?? 'capture';
  if (want !== 'capture' && !state.bitmap) return show('capture', false);
  if (want === 'result' && !state.last) return show('place', false);
  show(want, false);
});

// ---- Screen 1: capture ----

async function loadFile(file: File): Promise<void> {
  els.captureError.hidden = true;
  let bitmap: ImageBitmap;
  try {
    bitmap = await decodePhoto(file);
  } catch (err) {
    els.captureError.textContent = `Could not open that photo (${(err as Error).message || 'unknown error'}).`;
    els.captureError.hidden = false;
    return;
  }
  closePhoto();
  state.bitmap = bitmap;
  state.fileName = file.name;
  state.points = [];
  state.last = null;
  show('place');
  state.placement = new Placement(els.stage, bitmap, makeViewCanvas(bitmap), onPointsChange);
  updatePlaceUi();
}

function closePhoto(): void {
  state.placement?.destroy();
  state.placement = null;
  state.bitmap?.close();
  state.bitmap = null;
}

for (const input of [els.camera, els.gallery]) {
  input.addEventListener('change', () => {
    const file = input.files?.[0];
    input.value = '';
    if (file) void loadFile(file);
  });
}

// ---- Screen 2: line placement ----

function onPointsChange(points: Point[]): void {
  state.points = points.map((p) => ({ ...p }));
  updatePlaceUi();
}

function updatePlaceUi(): void {
  const n = state.points.length;
  els.hint.textContent =
    n === 0
      ? 'Pinch to zoom. Tap the middle of the first item.'
      : n === 1
        ? 'Now tap the middle of the last item.'
        : 'Drag either end to adjust, then Count.';
  els.placeCount.disabled = n < 2;
  els.placeReset.disabled = n === 0;
}

els.placeBack.addEventListener('click', () => history.back());
els.placeReset.addEventListener('click', () => state.placement?.clear());
els.placeCount.addEventListener('click', () => runCount());

// ---- Screen 3: result ----

function currentLine(): Line | null {
  if (state.points.length < 2) return null;
  const [a, b] = state.points;
  return { x1: a.x, y1: a.y, x2: b.x, y2: b.y };
}

function runCount(): void {
  const line = currentLine();
  const bitmap = state.bitmap;
  if (!line || !bitmap) return;
  els.placeCount.disabled = true;
  els.placeCount.textContent = 'Counting…';
  els.recount.disabled = true;
  // Let the button repaint before the synchronous work.
  requestAnimationFrame(() =>
    setTimeout(() => {
      try {
        const geom = stripGeometry(line, DEFAULTS.stripHalfHeight);
        const { canvas, image } = straightenStrip(bitmap, line, geom);
        const result = countStrip(toGray(image), geom, state.settings);
        state.last = { line, result };
        renderResult(els.result, result, canvas);
        els.annotation.hidden = true;
        if (screens.result.hidden) show('result');
      } finally {
        els.placeCount.textContent = 'Count';
        els.placeCount.disabled = state.points.length < 2;
        els.recount.disabled = false;
      }
    }, 0),
  );
}

els.adjust.addEventListener('click', () => history.back());
els.newPhoto.addEventListener('click', () => {
  closePhoto();
  state.points = [];
  state.last = null;
  show('capture');
});

els.band.addEventListener('input', () => {
  els.bandValue.textContent = els.band.value;
});
els.band.addEventListener('change', () => {
  state.settings.bandHalfWidth = Number(els.band.value);
  runCount();
});
els.invert.addEventListener('change', () => {
  state.settings.invert = els.invert.checked;
  runCount();
});
els.recount.addEventListener('click', () => runCount());

// Developer: copy a manifest entry so real use grows the test set.
els.copyAnnotation.addEventListener('click', async () => {
  if (!state.last) return;
  const r1 = (v: number) => Math.round(v * 10) / 10;
  const { line, result } = state.last;
  const trueCount = Number(els.devTrue.value);
  const entry: Record<string, unknown> = {
    image: state.fileName,
    line: { x1: r1(line.x1), y1: r1(line.y1), x2: r1(line.x2), y2: r1(line.y2) },
    trueCount: Number.isFinite(trueCount) && trueCount > 0 ? trueCount : null,
    notes: `app said ${result.count} (${result.confidence})`,
  };
  if (state.settings.invert || state.settings.bandHalfWidth !== DEFAULTS.bandHalfWidth) {
    entry.settings = { ...state.settings };
  }
  const text = JSON.stringify(entry, null, 2);
  els.annotation.value = text;
  els.annotation.hidden = false;
  try {
    await navigator.clipboard.writeText(text);
    els.copyAnnotation.textContent = 'Copied';
    setTimeout(() => (els.copyAnnotation.textContent = 'Copy annotation JSON'), 1500);
  } catch {
    els.annotation.select();
  }
});
