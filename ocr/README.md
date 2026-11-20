# Spine-reading model

`eng.traineddata.gz` is the English LSTM model from
[tesseract-ocr/tessdata_fast](https://github.com/tesseract-ocr/tessdata_fast)
4.1.0, gzipped (Apache License 2.0). It reads the stack spines as well as the
11 MB standard model at a fifth of the size. `vite.config.ts` serves it, with
Tesseract's worker and core from `node_modules`, under `./tesseract/`, so the
app never fetches OCR files from a CDN.
