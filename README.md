# Stack Counter

Count a stack of brochures or magazines from a phone photo. Open it in the
phone browser, take a photo of the side of the stack, tap the first item, tap
the last item, read the number.

Free, offline-capable (installs to the home screen as a PWA), MIT licensed.

## How it counts

A squared single-title stack seen from the side is a periodic stripe pattern.
The app straightens a thin strip of the photo under your line, measures the
stripe direction, averages along the stripes to get a 1-D brightness
profile, and then:

1. **Period count (the answer).** Splits the profile into overlapping
   windows of about 25 items, finds each window's stripe period by
   autocorrelation with sub-pixel refinement, and integrates
   `line length / local period`. Works down to about 3 px per item and
   handles perspective.
2. **Edge count (cross-check).** Counts prominent stripe peaks. Exact on
   thick magazines; its ticks are drawn on the result strip so misses are
   visible.
3. **Decision.** If both agree within the count tolerance (±1 up to 29 items, then 5%), the period count is
   reported. If not, thick items (> 8 px each) trust the edge count, thin
   items trust the period count, and the badge drops to *Check* or *Low*.

The line runs from the **middle of the first item to the middle of the last
item**, so the count is `length / period + 1`.

Code: [`src/algorithm/`](src/algorithm) (pure functions, identical in the
browser and in Node), [`src/ui/`](src/ui) (vanilla DOM, `@panzoom/panzoom`
for pinch zoom).

## Develop

```bash
npm install
npm run dev          # serves on the LAN; open http://<pc-ip>:5173 on the phone
npm test             # Vitest: synthetic profiles and synthetic photos
npm run build        # icons, type check, static build into dist/
```

Add `?dev` to the URL to show the developer tools on the result screen
(Settings → Developer → "Copy annotation JSON"), which produce manifest
entries for the accuracy harness.

## Accuracy harness

```bash
npm run synth                        # generate fixtures-synthetic/ (public, deterministic)
npm run harness -- fixtures-synthetic
npm run intake  -- fixtures          # Phase 0 table for your real photos
npm run harness -- fixtures          # Phase 1 gate on your real photos
```

The harness decodes each photo with `sharp` (EXIF rotation applied, same as
the browser), runs the same `countStack()` and prints the error per image,
the error distribution and how confidence relates to error. It exits
non-zero if fewer than 90% of images are within that tolerance of the true count,
or if any *Good*-confidence result is outside it.

Real photos live in `fixtures/`, which is git-ignored except for its README;
see [fixtures/README.md](fixtures/README.md) for the manifest format.

## Deploy

`.github/workflows/ci.yml` type-checks, runs the tests, runs the harness on
the synthetic set (and on `fixtures/` if a published subset is ever
committed), builds, and deploys `dist/` to GitHub Pages on pushes to `main`.
In the repo settings, set Pages → Source to "GitHub Actions".

## Status against the plan

- Phase 1 (algorithm core, unit tests, harness): implemented.
- Phase 2 (phone UI, PWA, Pages deploy, annotation button): implemented.
- Phase 0 (real photo intake) and the Phase 1/2 gates need your photos and
  hand counts.
- Phase 3 (auto-suggest line, remembered settings, sections mode) and
  Phase 4 (learned edge model): not started, by design.
