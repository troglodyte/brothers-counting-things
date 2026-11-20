# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo holds

**Stack Counter** is a phone-browser PWA that counts a stack of brochures or magazines from a side-on photo. The user taps the first item, then the last item, and the app reports the count. The target accuracy is max(5, 2%) of the true count. The repo is `troglodyte/brothers-counting-things` (private).

- `stack-counter-plan.md` is the design plan, with phases 0 to 4 and a gate for each. Read it before you change the algorithm or add features.
- `fixtures/` (git-ignored except its README) holds the six real stack photos, `6811.jpg` to `6816.jpg`, and a `manifest.json` with one line per photo. Every `trueCount` is still `null` until the user supplies hand counts. Each line end may be off by about one item. In 6813 only the front (brown) stack is annotated. 6815 and 6816 mix several titles of different thickness in one stack. The originals are also in `images/`, which is git-ignored. Never commit photos.
- These real photos are 7 to 30 thick items shot at an angle, at 31 to 237 px per item. That is far from the plan's assumed hundreds of thin items shot square-on.

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
   - If the two counts agree within max(3, 2%), it reports the period count.
   - If they disagree, items thicker than 8 px use the peak count and thinner items keep the period count. Confidence drops to *check* or *low*.
   - Under 2.5 px per item, or when the peak count is about 2× the period count (the period locked onto double), it reports "too far away".

`signal.ts` contains the shared DSP primitives: box, Gaussian, detrend, normalized autocorrelation, parabolic offset.

**UI.** The UI is vanilla DOM with no framework, by design. `main.ts` connects three screens: capture (`ui/capture.ts`), two-tap line placement with pinch-zoom and a loupe (`ui/placement.ts`, using `@panzoom/panzoom` pinned at 4.6.0), and the result screen (`ui/result.ts`). `vite.config.ts` sets `base: './'` so the same build works on Pages and on the LAN dev server. `vite-plugin-pwa` handles offline use and home-screen install.

**Tests.** `test/synth.ts` builds synthetic profiles and synthetic stack photos with known counts, perspective, noise and missing edges. `harness/make-synthetic.ts` uses the same generators to build the CI fixture set.

## Constraints from the plan

- Deliberately not used: OpenCV.js, TensorFlow.js, getUserMedia live preview, and any UI framework. A learned model is Phase 4 and only applies if the harness shows a class of images the classical method can't handle.
- Any algorithm change must pass `npm run harness`. It is the regression gate.
- `fixtures/*` is git-ignored except its README. Publish real photos only if the user approves.
