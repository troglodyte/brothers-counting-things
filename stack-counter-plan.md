# Stack Counter: a phone-browser counter for brochure and magazine stacks

## Context

The user hand-counts stacks of brochures and magazines, hundreds to thousands per
stack, and wants a free tool on their Android phone that counts a stack from a
photo. Commercial apps (CountThings and similar) are subscription-priced; the one
open-source Android counter ("how many?" on F-Droid) is a generic
"find things that look like this" tool and is not built for thin stacked edges.

Requirements the user confirmed:

- Brochures and magazines only. One title per stack, neatly squared.
- One stack at a time; the output is a number. No tally or history needed.
- Accuracy and ease of use over everything else. Tolerance scales with size
  (revised 2026-11-20): within 1 item up to 29, then 5 percent. Small stacks
  decide when to reorder; a 400+ stack only needs to be roughly right.
- Opened from the phone browser. Hosted as a new GitHub repo on GitHub Pages.
- The user can supply many real images, most with a known true count.

This is a new, standalone project. Nothing in `feral-processes` is touched.

## Why period measurement, not edge finding

A squared single-title stack photographed from the side is a periodic stripe
pattern: every item is the same thickness. Counting it as "stack length divided
by stripe period", measured in sliding windows along the stack, is far more
robust than detecting each individual edge:

- Period estimation is sub-pixel and works down to about 3 pixels per item,
  where per-edge detection has already fallen apart.
- A few blurred, shadowed, or stuck-together edges perturb a window's estimate
  slightly instead of dropping whole items from the count.
- Windowing handles perspective (items nearer the camera look thicker) and the
  photo not being perfectly square-on.

Per-edge peak counting is still computed and shown as a cross-check: on thick
magazines it is exact, and when the two methods disagree beyond tolerance the
app says so instead of printing a confident wrong number.

A trained model is not planned up front. With count-only labels there is nothing
to train an edge detector on, and the classical method should hit the tolerance
on squared stacks. It stays as a contingency (Phase 4) if the harness proves
otherwise on some class of images.

## Libraries and stack

| Need | Choice | Why |
|---|---|---|
| Language / build | TypeScript + Vite | One-screen app, fast dev loop, static output for Pages |
| UI framework | None (vanilla DOM) | One screen; a framework adds nothing |
| Pixel access | Canvas 2D `getImageData` on the region of interest only | A 50 MP photo as a full `ImageData` is 200 MB; sample only the band under the line |
| Photo capture | `<input type="file" accept="image/*" capture="environment">` + `createImageBitmap(file, {imageOrientation: "from-image"})` | Gets the full-resolution JPEG with EXIF rotation handled; no camera-stream permission dance, works over plain HTTP on the LAN for dev |
| Zoom and pan for line placement | `@panzoom/panzoom` (pinned) | Pinch-zoom on a phone is fiddly to hand-roll; this is small and touch-first |
| Signal processing | Hand-written: detrend, autocorrelation, parabolic peak refinement, prominence peak picking | Windows are a few hundred samples; no FFT library is needed. OpenCV.js (8 MB wasm) is the wrong tool here: Hough lines on thin stripes is what the hobby projects do and it is why they are unreliable |
| Offline / home-screen install | `vite-plugin-pwa` (Workbox manifest + service worker) | "Open it like an app", works in a stockroom with no signal |
| Unit tests | Vitest | Pure algorithm functions on synthetic profiles |
| Accuracy harness | Node script using `sharp` to decode fixture JPEGs, running the same TS algorithm | One implementation of the algorithm, scored against the user's real counts |
| Hosting / CI | GitHub Actions → GitHub Pages; harness runs in CI | Free HTTPS hosting, accuracy regression gate on every change |
| License | MIT | Matches the open-source intent |

Not used, deliberately: OpenCV.js, TensorFlow.js, getUserMedia live preview
(lower resolution than a captured photo, and more code), any UI framework.

## Repository layout

```
stack-counter/
  src/
    algorithm/
      profile.ts      # sample a grayscale profile along a line with band averaging
      period.ts       # windowed period estimation + confidence
      peaks.ts        # prominence-based peak counting
      count.ts        # combine the two, produce {count, confidence, ticks, warnings}
    ui/
      capture.ts      # photo input, bitmap decode, orientation
      placement.ts    # pinch-zoom view, two-tap line placement with loupe
      result.ts       # count, confidence badge, straightened strip with ticks, corrections
    main.ts
  harness/
    run.ts            # decode each fixture, run count(), print error table, exit non-zero over threshold
    manifest.json     # [{image, line: {x1,y1,x2,y2}, trueCount, notes}]
  fixtures/           # the user's images (see privacy note)
  test/               # Vitest: synthetic stripe profiles with known period and noise
  .github/workflows/  # build, test, harness, deploy to Pages
```

Fixtures privacy: images stay out of the public repo unless the user says they
are fine to publish. Default is a git-ignored `fixtures/` folder; the harness
takes a path, and CI runs it only when the folder is present (or against a small
published subset the user approves).

## The algorithm

Input: full-resolution bitmap, a line from the first item to the last item
(two taps), optional settings (band half-width, invert, window length).

1. **Stripe orientation.** In a strip around the line, build a gradient
   orientation histogram and take the dominant direction. Stripes should run
   perpendicular to the user's line; use the measured angle, not the assumed
   one, for band averaging. This is what makes a slightly crooked tap harmless.
2. **Profile.** For each pixel step along the line, average grayscale along the
   stripe direction over the band half-width (default 6 px). Light smoothing
   (sigma 1 px). Output: a 1-D signal of length = line length in pixels.
3. **Windowed period.** Split the profile into overlapping windows (target 25
   periods each; first pass uses a coarse global period from the whole-profile
   autocorrelation to size them). Per window: detrend with a moving average,
   autocorrelate, take the first strong peak, refine to sub-pixel with a
   parabola. Window count = window length / period. Weak windows (autocorr
   peak below threshold) are flagged and take the interpolated period from
   neighbours. Total = sum of window counts. Confidence = share of strong
   windows and the spread of their periods.
4. **Peak cross-check.** On the detrended profile, pick peaks with prominence
   above k times the local standard deviation and minimum spacing of 0.5 times
   the local period. Count them. Also produce the tick positions for display.
5. **Decision.** If the two counts agree within the count tolerance, report the
   period count with high confidence. If not: on coarse periods (more than 8 px
   per item, i.e. magazines) prefer the peak count; on fine periods prefer the
   period count; always show both and the warning. Items per pixel below about
   2.5 is reported as "too far away, move closer or photograph in sections".

Settings exposed on the result screen only when the user wants them: invert
(count dark lines instead of bright), band width, "recount with a longer or
shorter line". Default path is tap, tap, number.

## Phases and gates

### Phase 0: Image intake and feasibility (before any app code)

- User supplies images and true counts. Build `manifest.json` with the line
  endpoints annotated. Annotation is done in the app's own placement screen
  (Phase 2 ships a "copy annotation" developer button), but for Phase 0 a
  quick Node script that prints image sizes plus a one-off manual line per
  image is enough.
- Measure **pixels per item** for every image (line length in px divided by
  true count). This single number decides everything:
  - median above 6 px: straightforward.
  - 3 to 6 px: the period method is required; peak counting is a cross-check
    only.
  - below 3 px: add a "sections" capture mode to Phase 2 (photograph the stack
    in two or three overlapping closer shots, count each, sum; overlap handled
    by the user placing the line between two marked items).
- Also note: which side of the stack is photographed (spine or open edge),
  lighting, phone camera resolution. Expect the spine side of saddle-stitched
  magazines and folded brochures to score best; the harness confirms or
  refutes it.

Gate: a table of px-per-item and image conditions, and a decision on whether
the sections mode is in scope.

### Phase 1: Algorithm core and harness (Node only, no UI)

- Implement `profile.ts`, `period.ts`, `peaks.ts`, `count.ts` as pure functions
  over `{width, height, data: Uint8ClampedArray}` so they run identically in
  Node and the browser.
- Vitest: synthetic profiles (known period, additive noise, slow brightness
  gradient, 5 percent of edges missing) must count within 1 percent.
- Harness over the real fixtures: error per image, error distribution,
  confidence vs actual error (confidence must correlate, or the warning is
  useless).

Gate: at least 90 percent of fixtures within the user's tolerance
(see Context: ±1 up to 29 items, then 5 percent), and no high-confidence result outside it. If a class of
images fails, Phase 0's notes say why (lighting, side, distance) and that
feeds the capture tips in Phase 2 before anyone reaches for a model.

### Phase 2: Phone UI and deployment

- Screen 1: big "Take photo" button, plus "Choose from gallery". Three capture
  tips drawn from Phase 1 (square-on, fill the frame along the stack, light
  from the side or flash on).
- Screen 2: photo with pinch-zoom. Tap the first item, tap the last item; a
  loupe shows the magnified area under the finger so an endpoint lands within
  an item or two. Endpoints are draggable afterwards.
- Screen 3: the number, large. Under it: a confidence badge (good / check /
  low), the straightened strip of the stack with the detected ticks drawn on
  it so misses are visible at a glance, and the cross-check count. Buttons:
  recount, adjust line, settings.
- PWA install, offline cache, deploy workflow to Pages. Developer-only
  "copy annotation JSON" button to grow the fixture manifest from real use.

Gate: the user counts 10 real stacks blind with the phone and compares to
hand counts; all within tolerance, and no stack took more than about 30
seconds including the photo.

### Phase 3: Ease-of-use polish (only what the Phase 2 trial asks for)

Candidates, picked by what actually slowed the user down:

- Auto-suggest the line: find the region of strongest periodic texture and its
  extent, pre-place the endpoints, user confirms or nudges.
- Remember the last settings per title (local storage, best effort).
- Sections mode if Phase 0 put it in scope and it was not already needed.

### Phase 4: Contingency, a learned edge model

Only if the harness shows a class of images the classical method cannot
handle after capture guidance. Route: annotate edges on failing images using
the app's corrected ticks as labels, train a small U-Net style edge
probability model in PyTorch, export to ONNX, run in the browser with
`onnxruntime-web`, and feed its output into the same `period.ts` / `peaks.ts`
pipeline in place of the raw grayscale profile. This is a separate plan if it
is ever needed.

## Verification

- `npm test`: Vitest synthetic suite, run in CI.
- `npm run harness -- fixtures/`: error table over real images; CI fails if the
  tolerance share drops below 90 percent. This is the regression gate for any
  algorithm change.
- Phone trial per Phase 2 gate: blind counts of 10 real stacks against hand
  counts, timed.
- Manual check that the deployed Pages site installs to the Android home
  screen and counts with the network off.

## Open assumptions (say so if any is wrong)

- Repo name `stack-counter` under the user's GitHub account, MIT licensed.
- The phone is a reasonably current Android with a 12 MP or better main camera
  and Chrome.
- Fixture images are not published by default.
- No tally, history, or export; one number per stack.
