# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo holds

**Stack Counter** is a phone-browser PWA that counts a stack of brochures or magazines from a side-on photo. The user shoots with the in-app camera, drags from the first item to the last, and the count updates live; "Save & next" adds it to a running list. Speed per stack matters: the user counts many stacks in one go, so avoid adding taps, menus or screens to the main path (user, 2026-11-20). The target accuracy is `countTolerance(n)` in `src/algorithm/count.ts`: ±1 item up to 29, then 5% (±3 at 60, ±20 at 400). The user chose this on 2026-11-20 because small stacks decide when to reorder, while big stacks only need to be roughly right. The repo is `troglodyte/brothers-counting-things` (public). The app is live at https://troglodyte.github.io/brothers-counting-things/ and redeploys on every push to `main`.

- `stack-counter-plan.md` is the design plan, with phases 0 to 4 and a gate for each. Read it before you change the algorithm or add features.
- `fixtures/` (git-ignored except its README) holds the six real stack photos, `6811.jpg` to `6816.jpg`, and a `manifest.json` with one line per photo. The true counts are the user's: 6811 ≈ 23, 6812 = 20, 6813 = 7, 6814 ≈ 22, 6815 ≈ 60, and 6816 ≈ 60 (6816 is the same stack as 6815). Each line end may be off by about one item. In 6813 only the front (brown) stack is annotated. 6815 and 6816 mix several titles of different thickness in one stack. The originals are also in `images/`, which is git-ignored. Never commit photos.
- **These photos are the real use case** (confirmed by the user on 2026-11-20). The stacks hold 7 to 60 thick books, magazines or brochures, shot at an angle, at 31 to 237 px per item, and some mix titles. The plan assumed hundreds of thin, single-title items shot square-on, so its thin-item concerns matter less than oblique views, perspective and mixed thicknesses.
- **The browser and the harness disagree on 6811.** With the same line, the app counts 6 (6 by spacing, 7 by edges, 567 px per item), while `countStack` in the harness gets 25 to 27. Other photos differ by 1 to 6 too. The browser path (`ui/capture.straightenStrip` on a canvas) and the Node path (`profile.extractStrip`) must produce the same strip; find out why they don't before tuning anything against the harness.
- Results under the new tolerance (2026-11-20): 4/6 pass, which fails the gate. Errors are +2, +2, 0, −1, −3 and −1, and no *good* result is wrong. Above 8 px per item, a disagreement makes `count.ts` switch to the edge count. That fixes the thick-item over-count of the spacing method on 6811 and 6814, but breaks 6812 (spacing 20 is exact, edges 22). Neither method is reliable yet on thick items.

## Commands

```bash
npm install
npm run dev                  # vite --host: open http://<pc-ip>:5173 on the phone
npm test                     # vitest run (test/**/*.test.ts)
npx vitest run -t "<name>"   # run a single test by name
npm run typecheck            # tsc --noEmit
npm run build                # icons (tsx scripts/make-icons.ts) + typecheck + vite build -> dist/

npm run synth                          # generate fixtures-synthetic/ (deterministic, git-ignored)
npm run harness -- fixtures-synthetic  # accuracy gate on the synthetic set
npm run intake  -- fixtures            # Phase 0: image sizes and px-per-item table
npm run harness -- fixtures            # accuracy gate on the real photos
# harness flags: --min-share 0.9, --if-present, --json out.json
```

Add `?dev` to the app URL to show Settings → Developer → "Copy annotation JSON". It produces `manifest.json` entries for the harness. The manifest format is in `fixtures/README.md`: each entry has `image`, `line {x1,y1,x2,y2}` in full-resolution pixels after EXIF rotation, `trueCount` (or `null`), and optional `settings`.

The harness **exits non-zero** in two cases: fewer than 90% of images are within tolerance, or any result with *good* confidence is outside it. CI (`.github/workflows/ci.yml`) runs typecheck, the tests, the synthetic harness, the real harness with `--if-present`, and the build, then deploys `dist/` to GitHub Pages on pushes to `main`.

## Architecture

**One algorithm, two runtimes.** `src/algorithm/` contains pure functions over `{width, height, data}`. They run unchanged in the browser and in Node, where `harness/manifest.ts` decodes images with `sharp` and applies EXIF rotation to match `createImageBitmap(..., {imageOrientation: "from-image"})`. Keep DOM and Node APIs out of `src/algorithm/`.

There are two entry points in `count.ts`:

- `countStack(img, line)` is the Node and harness path. It straightens the strip itself with `profile.extractStrip`, a bilinear resample that reads only the pixels it needs.
- `countStrip(strip, geom)` is the browser path. There, `ui/capture.straightenStrip` straightens the strip on a canvas first.

If straightening changes in one path, it has to change in the other too, or the harness stops being representative.

**Pipeline.** The method is period measurement, not edge finding (the plan explains why):

1. `profile.ts` gets the stripe angle from the gradient structure tensor. It then averages along the measured stripe direction over a band (6 px half-width by default) to produce a 1-D profile.
2. `period.ts` (windowed period, the answer) estimates a coarse global period by autocorrelation. It then uses overlapping windows of about 25 periods each: detrend, autocorrelate, refine to sub-pixel with a parabola. Weak windows take their period from neighbouring windows. The count is the integral of 1/period, **plus 1**, because the line runs from the middle of the first item to the middle of the last item.
3. `peaks.ts` (cross-check) counts peaks by local prominence and supplies the tick marks drawn on the result strip.
4. `count.ts` decides the answer:
   - If the two counts agree within `countTolerance`, it reports the period count.
   - If they disagree, items thicker than 8 px use the peak count and thinner items keep the period count. Confidence drops to *check* or *low*.
   - Under 2.5 px per item, or when the peak count is about 2× the period count (the period locked onto double), it reports "too far away".

`signal.ts` contains the shared DSP primitives: box, Gaussian, detrend, normalized autocorrelation, parabolic offset.

**UI.** The UI is vanilla DOM with no framework, by design. `main.ts` connects three screens: the viewfinder (`ui/camera.ts`, getUserMedia, grabs a video frame; falls back to a file input without HTTPS or camera permission, and `ui/capture.ts` decodes gallery files), line placement (`ui/placement.ts`: one-finger drag draws the line, handles adjust it, two fingers pinch/pan, a loupe, ticks drawn on the photo; its own gesture code because a pan library would steal the one-finger drag) with the live count under it (`ui/result.ts`, details collapsed), and the running list (`ui/tally.ts`, kept in localStorage). The count runs on every animation frame while dragging (about 10 ms).

**Stack names.** After each count the name box is filled, unless the user has typed in it. First choice is a title the user named before, matched by look: `algorithm/appearance.ts` builds a colour histogram of the spines around the line, and `ui/titles.ts` stores up to 8 looks per name in localStorage. A match needs a score of at least 0.85 and a clear lead over the runner-up title. On the real photos the same stack scores 0.98 and different titles 0.67 or less. Failing a match, `ui/spine.ts` reads the spines with Tesseract.js at three sizes and keeps the reading that recurs across items. In the browser it got "Bearing Witness" on 6811, only "School" on 6812, and nothing on the others, so treat it as a fallback. Tesseract's sparse-text mode is touchy about scale, and one-step canvas downscaling blurs the letters too much, hence `shrink()`. The OCR files (about 6 MB) are lazy-loaded from `./tesseract/` and cached at runtime; `vite.config.ts` copies them in and `ocr/README.md` has the details. A blank name shows as "Stack N". `vite.config.ts` sets `base: './'` so the same build works on Pages and on the LAN dev server. `vite-plugin-pwa` handles offline use and home-screen install.

**Tests.** `test/synth.ts` builds synthetic profiles and synthetic stack photos with known counts, perspective, noise and missing edges. `harness/make-synthetic.ts` uses the same generators to build the CI fixture set.

## Constraints from the plan

- Deliberately not used: OpenCV.js, TensorFlow.js, and any UI framework. The plan also ruled out a getUserMedia preview (lower resolution), but the user chose the in-app camera for speed on 2026-11-20; video frames still give 10+ px per item on their thick items. A learned model is Phase 4 and only applies if the harness shows a class of images the classical method can't handle.
- Any algorithm change must pass `npm run harness`. It is the regression gate.
- `fixtures/*` is git-ignored except its README. Publish real photos only if the user approves.
