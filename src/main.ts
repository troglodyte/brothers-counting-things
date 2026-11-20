import './style.css';
import { lookHalfWidth, stackLook } from './algorithm/appearance';
import { countStrip, DEFAULTS, type CountOptions, type CountResult } from './algorithm/count';
import { stripGeometry, toGray, type Line, type Point } from './algorithm/profile';
import { Camera } from './ui/camera';
import { decodePhoto, makeViewCanvas, straightenStrip } from './ui/capture';
import { autoCount, LiveView } from './ui/live';
import { Placement } from './ui/placement';
import { renderDetails, renderSummary } from './ui/result';
import { closestName, readSpine } from './ui/spine';
import { Tally } from './ui/tally';
import { Titles } from './ui/titles';

// Flow per stack (Auto line, the default): aim the guide line down the stack,
// the count follows live -> shutter opens the photo with the line on the found
// ends -> "Save & next". Draw line mode: shutter -> drag first-to-last ->
// "Save & next". Either way the photo screen is the same, and a wrong end is
// one drag away.

type ScreenName = 'camera' | 'place' | 'list';

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as T;
};

const screens: Record<ScreenName, HTMLElement> = {
  camera: $('screen-camera'),
  place: $('screen-place'),
  list: $('screen-list'),
};

const els = {
  video: $<HTMLVideoElement>('video'),
  cameraOff: $('camera-off'),
  cameraOffMsg: $('camera-off-msg'),
  shutter: $<HTMLButtonElement>('btn-shutter'),
  mode: $<HTMLButtonElement>('btn-mode'),
  vfHint: $('vf-hint'),
  liveOverlay: $<HTMLCanvasElement>('live-overlay'),
  liveReadout: $('live-readout'),
  torch: $<HTMLButtonElement>('btn-torch'),
  listOpen: $<HTMLButtonElement>('btn-list'),
  listBadge: $('list-badge'),
  camera: $<HTMLInputElement>('input-camera'),
  gallery: $<HTMLInputElement>('input-gallery'),
  captureError: $('capture-error'),
  stage: $('stage'),
  name: $<HTMLInputElement>('stack-name'),
  names: $('stack-names'),
  nameNote: $('name-note'),
  retake: $<HTMLButtonElement>('btn-retake'),
  save: $<HTMLButtonElement>('btn-save'),
  band: $<HTMLInputElement>('set-band'),
  bandValue: $('set-band-value'),
  devTools: $('dev-tools'),
  devTrue: $<HTMLInputElement>('dev-true'),
  copyAnnotation: $<HTMLButtonElement>('btn-copy-annotation'),
  savePhoto: $<HTMLButtonElement>('btn-save-photo'),
  annotation: $<HTMLTextAreaElement>('dev-annotation'),
  listBack: $<HTMLButtonElement>('btn-list-back'),
  listItems: $('list-items'),
  listEmpty: $('list-empty'),
  listTotal: $('list-total'),
  listCopy: $<HTMLButtonElement>('btn-list-copy'),
  listShare: $<HTMLButtonElement>('btn-list-share'),
  listClear: $<HTMLButtonElement>('btn-list-clear'),
  result: {
    count: $('result-count'),
    badge: $('result-badge'),
    hint: $('place-hint'),
    cross: $('result-cross'),
    warnings: $('result-warnings'),
    strip: $('strip-scroll'),
  },
};

const camera = new Camera(els.video);
const tally = new Tally();
const titles = new Titles();

// ---- Line mode: Auto (live, ends found) or Draw (the user drags the line) ----

type LineMode = 'auto' | 'draw';
const MODE_KEY = 'stack-counter.mode.v1';
function loadMode(): LineMode {
  try {
    return localStorage.getItem(MODE_KEY) === 'draw' ? 'draw' : 'auto';
  } catch {
    return 'auto';
  }
}
let lineMode = loadMode();

const state: {
  screen: ScreenName;
  bitmap: ImageBitmap | null;
  fileName: string;
  placement: Placement | null;
  points: Point[];
  settings: Required<Pick<CountOptions, 'bandHalfWidth'>>;
  last: { line: Line; result: CountResult } | null;
  /** Who filled the name box: the user (never overwrite), a look match, or the spine. */
  nameSource: 'user' | 'look' | 'spine' | null;
  look: Float32Array | null;
  spineRead: boolean;
  photoId: number;
  /** Save or Retake was tapped and the screen is on its way out: ignore further taps. */
  leaving: boolean;
} = {
  screen: 'camera',
  bitmap: null,
  fileName: '',
  placement: null,
  points: [],
  settings: { bandHalfWidth: DEFAULTS.bandHalfWidth },
  last: null,
  nameSource: null,
  look: null,
  spineRead: false,
  photoId: 0,
  leaving: false,
};

const live = new LiveView(els.video, els.liveOverlay, els.liveReadout, () => state.settings);

if (new URLSearchParams(location.search).has('dev')) els.devTools.hidden = false;

// ---- Navigation (Android back button steps back to the viewfinder) ----

function show(name: ScreenName, push = true): void {
  state.screen = name;
  for (const [k, el] of Object.entries(screens)) el.hidden = k !== name;
  if (push && history.state?.screen !== name) history.pushState({ screen: name }, '');
  if (name === 'camera') void startCamera();
  syncLive();
  // Stay live behind the photo screen so "Save & next" is instant; the list can wait.
  if (name === 'list') camera.stop();
  if (name === 'list') renderList();
  window.scrollTo(0, 0);
}

history.replaceState({ screen: 'camera' }, '');
window.addEventListener('popstate', (e) => {
  const want = (e.state?.screen as ScreenName | undefined) ?? 'camera';
  if (want === 'place' && !state.bitmap) return show('camera', false);
  if (want !== 'place') closePhoto();
  show(want, false);
});

// ---- Screen 1: viewfinder ----

async function startCamera(): Promise<void> {
  if (!Camera.supported()) return cameraUnavailable('The camera needs HTTPS. Use the button below instead.');
  if (camera.running) return;
  try {
    await camera.start();
    if (!camera.running) return; // stopped while starting (app went to the background)
    els.cameraOff.hidden = true;
    els.shutter.disabled = false;
    els.torch.hidden = !camera.hasTorch;
    setTorchState(false); // a fresh stream starts with the light off
    syncLive();
  } catch (err) {
    const name = (err as Error).name;
    cameraUnavailable(
      name === 'NotAllowedError'
        ? 'Camera access was blocked. Allow it in the browser’s site settings, or use the button below.'
        : `Could not start the camera (${(err as Error).message || name}).`,
    );
  }
}

function cameraUnavailable(msg: string): void {
  els.cameraOffMsg.textContent = msg;
  els.cameraOff.hidden = false;
  els.shutter.disabled = true;
}

// Release the camera when the app is in the background; take it back on return.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) camera.stop();
  else if (state.screen === 'camera') void startCamera();
  syncLive();
});

/** Count live only on the viewfinder, with the camera on, in Auto line mode. */
function syncLive(): void {
  if (state.screen === 'camera' && camera.running && lineMode === 'auto' && !document.hidden) live.start();
  else live.stop();
}

function applyMode(): void {
  const auto = lineMode === 'auto';
  els.mode.textContent = auto ? 'Auto line' : 'Draw line';
  els.mode.setAttribute('aria-pressed', String(auto));
  els.mode.setAttribute('aria-label', auto ? 'Auto line: on. Tap to draw the line yourself.' : 'Draw line: on. Tap to find the ends automatically.');
  els.vfHint.textContent = auto
    ? 'Aim the dashed line down the stack, top to bottom.'
    : 'Fit the whole stack in, side on, bottom item to top item.';
  syncLive();
}

els.mode.addEventListener('click', () => {
  lineMode = lineMode === 'auto' ? 'draw' : 'auto';
  try {
    localStorage.setItem(MODE_KEY, lineMode);
  } catch {
    // Private mode: the choice lasts for this session only.
  }
  applyMode();
});

els.shutter.addEventListener('click', async () => {
  try {
    const bitmap = await camera.grab();
    // Find the ends again on the frame actually taken; the live one may be a moment old.
    // Nothing found: the photo opens without a line, as in Draw line mode.
    let line: Line | undefined;
    if (lineMode === 'auto') {
      try {
        line = autoCount(bitmap, bitmap.width, bitmap.height, state.settings)?.line;
      } catch {
        line = undefined;
      }
    }
    openPhoto(bitmap, `stack-${stamp()}.jpg`, line);
  } catch (err) {
    showCaptureError(`Could not take the photo (${(err as Error).message}).`);
  }
});

let torchOn = false;
function setTorchState(on: boolean): void {
  torchOn = on;
  els.torch.setAttribute('aria-pressed', String(on));
}
els.torch.addEventListener('click', async () => {
  const want = !torchOn;
  try {
    await camera.setTorch(want);
    setTorchState(want);
  } catch {
    setTorchState(false);
  }
});

for (const input of [els.camera, els.gallery]) {
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    try {
      openPhoto(await decodePhoto(file), file.name);
    } catch (err) {
      showCaptureError(`Could not open that photo (${(err as Error).message || 'unknown error'}).`);
    }
  });
}

function showCaptureError(msg: string): void {
  els.captureError.textContent = msg;
  els.captureError.hidden = false;
}

function stamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// ---- Screen 2: draw the line, count live ----

function openPhoto(bitmap: ImageBitmap, fileName: string, line?: Line): void {
  els.captureError.hidden = true;
  closePhoto();
  state.bitmap = bitmap;
  state.fileName = fileName;
  els.name.value = '';
  els.name.placeholder = `Stack ${tally.entries.length + 1}`;
  setNameNote('');
  els.name.classList.remove('auto');
  state.nameSource = null;
  state.look = null;
  state.spineRead = false;
  state.photoId++;
  state.leaving = false;
  els.annotation.hidden = true;
  renderSummary(els.result, null);
  els.result.cross.textContent = '';
  els.result.warnings.replaceChildren();
  els.result.strip.replaceChildren();
  els.save.disabled = true;
  show('place');
  state.placement = new Placement(els.stage, bitmap, makeViewCanvas(bitmap), onPointsChange);
  if (line) state.placement.setPoints([{ x: line.x1, y: line.y1 }, { x: line.x2, y: line.y2 }]);
}

function closePhoto(): void {
  state.placement?.destroy();
  state.placement = null;
  state.bitmap?.close();
  state.bitmap = null;
  state.points = [];
  state.last = null;
}

// While dragging, count at most once per frame; on release, count and draw the detail.
let frame = 0;
function onPointsChange(points: Point[], live: boolean): void {
  state.points = points.map((p) => ({ ...p }));
  cancelAnimationFrame(frame);
  if (live) frame = requestAnimationFrame(() => runCount(false));
  else runCount(true);
}

function currentLine(): Line | null {
  if (state.points.length < 2) return null;
  const [a, b] = state.points;
  return { x1: a.x, y1: a.y, x2: b.x, y2: b.y };
}

function runCount(details: boolean): void {
  const line = currentLine();
  const bitmap = state.bitmap;
  if (!bitmap) return;
  if (!line) {
    // The line was abandoned (a pinch took over before there was one): nothing to save.
    state.last = null;
    renderSummary(els.result, null);
    state.placement?.setTicks([]);
    els.save.disabled = true;
    return;
  }
  const geom = stripGeometry(line, DEFAULTS.stripHalfHeight);
  const { canvas, image } = straightenStrip(bitmap, line, geom);
  const result = countStrip(toGray(image), geom, state.settings);
  state.last = { line, result };

  renderSummary(els.result, result);
  // Strip columns -> image points along the line.
  const L = geom.length || 1;
  const dx = (line.x2 - line.x1) / L;
  const dy = (line.y2 - line.y1) / L;
  state.placement?.setTicks(
    result.ticks.map((u) => ({ x: line.x1 + (u - geom.margin) * dx, y: line.y1 + (u - geom.margin) * dy })),
  );
  if (details) {
    renderDetails(els.result, result, canvas);
    const usable = result.count !== null && result.count > 0;
    els.save.disabled = !usable;
    if (usable) suggestName(bitmap, line, result);
  }
}

// ---- Name: a title seen before (by look), else what the spine says ----

function suggestName(bitmap: ImageBitmap, line: Line, result: CountResult): void {
  const geom = stripGeometry(line, lookHalfWidth(result.pxPerItem));
  state.look = stackLook(straightenStrip(bitmap, line, geom).image, geom);
  if (state.nameSource === 'user') return;
  const known = state.look && titles.match(state.look);
  if (known) return setAutoName(known.name, 'look', 'Recognised from an earlier stack.');
  if (state.spineRead) return;
  state.spineRead = true;
  const photo = state.photoId;
  setNameNote('Reading the spine…');
  readSpine(bitmap, line)
    .then((text) => {
      // A redrawn line may have matched a known title by look meanwhile; that wins.
      if (photo !== state.photoId || state.nameSource !== null) return;
      if (!text) return setNameNote('');
      const name = closestName(text, [...titles.names(), ...tally.names()]) ?? text;
      setAutoName(name, 'spine', 'Read from the spine. Check it.');
    })
    .catch(() => {
      if (photo === state.photoId && state.nameSource === null) setNameNote('');
    });
}

function setAutoName(name: string, source: 'look' | 'spine', note: string): void {
  els.name.value = name;
  els.name.classList.add('auto');
  state.nameSource = source;
  setNameNote(note);
}

function setNameNote(text: string): void {
  els.nameNote.textContent = text;
  els.nameNote.hidden = !text;
}

els.name.addEventListener('input', () => {
  state.nameSource = els.name.value ? 'user' : null;
  els.name.classList.remove('auto');
  setNameNote('');
});

/** Back to the viewfinder, once: a double tap must not step back twice and leave the app. */
function leavePhoto(): void {
  if (state.leaving || state.screen !== 'place') return;
  state.leaving = true;
  history.back();
}

els.retake.addEventListener('click', leavePhoto);

els.save.addEventListener('click', () => {
  const r = state.last?.result;
  if (state.leaving || !r || r.count === null || r.count < 1) return;
  const name = els.name.value.trim();
  if (name && state.look) titles.learn(name, state.look);
  tally.add({ name, count: r.count, confidence: r.confidence, at: Date.now() });
  updateListBadge();
  leavePhoto();
});

els.band.addEventListener('input', () => {
  els.bandValue.textContent = els.band.value;
});
els.band.addEventListener('change', () => {
  state.settings.bandHalfWidth = Number(els.band.value);
  runCount(true);
});

// Developer: a manifest entry plus the photo itself, so real use grows the test set.
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
  if (state.settings.bandHalfWidth !== DEFAULTS.bandHalfWidth) {
    entry.settings = { ...state.settings };
  }
  const text = JSON.stringify(entry, null, 2);
  els.annotation.value = text;
  els.annotation.hidden = false;
  try {
    await navigator.clipboard.writeText(text);
    flash(els.copyAnnotation, 'Copied');
  } catch {
    els.annotation.select();
  }
});

els.savePhoto.addEventListener('click', () => {
  const bitmap = state.bitmap;
  if (!bitmap) return;
  const c = document.createElement('canvas');
  c.width = bitmap.width;
  c.height = bitmap.height;
  c.getContext('2d')!.drawImage(bitmap, 0, 0);
  c.toBlob(
    (blob) => {
      if (!blob) return;
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = state.fileName.replace(/\.\w+$/, '') + '.jpg';
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
    },
    'image/jpeg',
    0.95,
  );
});

function flash(btn: HTMLButtonElement, text: string): void {
  const before = btn.textContent;
  btn.textContent = text;
  setTimeout(() => (btn.textContent = before), 1500);
}

// ---- Screen 3: the list ----

function updateListBadge(): void {
  els.listBadge.textContent = String(tally.entries.length);
  els.names.replaceChildren(
    ...[...new Set([...tally.names(), ...titles.names()])].map((n) => {
      const o = document.createElement('option');
      o.value = n;
      return o;
    }),
  );
}

function renderList(): void {
  const empty = tally.entries.length === 0;
  els.listEmpty.hidden = !empty;
  els.listTotal.textContent = empty ? '' : `Total ${tally.total} across ${tally.entries.length} stacks`;
  els.listCopy.disabled = empty;
  els.listShare.disabled = empty;
  els.listClear.disabled = empty;
  els.listItems.replaceChildren(
    ...tally.entries.map((e, i) => {
      const li = document.createElement('li');
      const name = document.createElement('span');
      name.className = 'li-name';
      name.textContent = e.name || `Stack ${i + 1}`;
      const count = document.createElement('span');
      count.className = `li-count ${e.confidence}`;
      count.textContent = String(e.count);
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'li-del';
      del.setAttribute('aria-label', `Remove ${name.textContent}`);
      del.textContent = '×';
      del.addEventListener('click', () => {
        tally.remove(i);
        updateListBadge();
        renderList();
      });
      li.append(name, count, del);
      return li;
    }),
  );
}

els.listOpen.addEventListener('click', () => show('list'));
els.listBack.addEventListener('click', () => history.back());
els.listCopy.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(tally.toText());
    flash(els.listCopy, 'Copied');
  } catch {
    flash(els.listCopy, 'Copy failed');
  }
});
if ('share' in navigator) els.listShare.hidden = false;
els.listShare.addEventListener('click', () => {
  navigator.share({ title: 'Stack counts', text: tally.toText() }).catch(() => {});
});
els.listClear.addEventListener('click', () => {
  if (!confirm(`Clear all ${tally.entries.length} counts?`)) return;
  tally.clear();
  updateListBadge();
  renderList();
});

// ---- Start ----

updateListBadge();
applyMode();
show('camera', false);
