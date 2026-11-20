# fixtures/ (private)

Everything in this folder except this README is git-ignored, so real stack
photos never reach the public repo by accident.

Put your photos here with a `manifest.json` next to them:

```json
[
  {
    "image": "IMG_20261119_101500.jpg",
    "line": { "x1": 1520.5, "y1": 3820.0, "x2": 1498.0, "y2": 410.2 },
    "trueCount": 412,
    "notes": "folded brochures, spine side, window light"
  }
]
```

- `line` runs from the **middle of the first item** to the **middle of the
  last item**, in full-resolution pixels after EXIF rotation. The easiest way
  to get it: open the app with `?dev` on the URL, place the line, count, then
  Settings → Developer → "Copy annotation JSON". Type the hand count first and
  it is filled in.
- `trueCount` is your hand count, or `null` if you don't know it (the entry is
  then skipped by the harness but still listed by intake).
- Optional `settings`: `{ "bandHalfWidth": 10 }` if that image
  needs non-default settings.

Then:

```bash
npm run intake -- fixtures      # Phase 0: sizes and px-per-item table
npm run harness -- fixtures     # Phase 1: accuracy table and gate
```
