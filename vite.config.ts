/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';
import { createHash } from 'node:crypto';
import { createReadStream, readFileSync } from 'node:fs';
import type { Plugin } from 'vite';

// Spine reading (src/ui/spine.ts) loads Tesseract's worker, core and English
// model from ./tesseract-<hash>/ rather than a CDN, so it works offline and sends
// nothing anywhere. Served from node_modules in dev, copied into dist/ on build.
const OCR_FILES: Record<string, string> = {
  'worker.min.js': 'node_modules/tesseract.js/dist/worker.min.js',
  'tesseract-core-simd-lstm.wasm.js': 'node_modules/tesseract.js-core/tesseract-core-simd-lstm.wasm.js',
  'tesseract-core-lstm.wasm.js': 'node_modules/tesseract.js-core/tesseract-core-lstm.wasm.js',
  // tessdata_fast 4.1.0 (Apache-2.0): 2 MB, reads spines as well as the 11 MB model.
  'eng.traineddata.gz': 'ocr/eng.traineddata.gz',
};

// The directory is named after a hash of the files, so the runtime cache
// (CacheFirst, below) never serves an old worker with a new core or model.
const OCR_DIR = (() => {
  const h = createHash('sha256');
  for (const src of Object.values(OCR_FILES)) h.update(readFileSync(src));
  return `tesseract-${h.digest('hex').slice(0, 10)}`;
})();

function ocrAssets(): Plugin {
  return {
    name: 'ocr-assets',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const m = req.url?.match(new RegExp(`/${OCR_DIR}/([^?]+)`));
        const src = m && OCR_FILES[m[1]];
        if (!src) return next();
        res.setHeader('Content-Type', src.endsWith('.js') ? 'text/javascript' : 'application/octet-stream');
        createReadStream(src).pipe(res);
      });
    },
    generateBundle() {
      for (const [name, src] of Object.entries(OCR_FILES)) {
        this.emitFile({ type: 'asset', fileName: `${OCR_DIR}/${name}`, source: readFileSync(src) });
      }
    },
  };
}

export default defineConfig({
  // Relative base works both at user.github.io/stack-counter/ and on a LAN dev server.
  base: './',
  define: { __OCR_DIR__: JSON.stringify(OCR_DIR) },
  plugins: [
    ocrAssets(),
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: 'auto',
      includeAssets: ['icon.svg'],
      manifest: {
        name: 'Stack Counter',
        short_name: 'Stack Count',
        description: 'Count a stack of brochures or magazines from a photo.',
        start_url: '.',
        scope: '.',
        display: 'standalone',
        orientation: 'portrait',
        background_color: '#14171c',
        theme_color: '#14171c',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          { src: 'icon.svg', sizes: 'any', type: 'image/svg+xml' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,webmanifest}'],
        // OCR files are big and only needed for unrecognised stacks: cache on first use.
        globIgnores: ['tesseract-*/**'],
        runtimeCaching: [
          {
            urlPattern: /\/tesseract-[0-9a-f]+\//,
            handler: 'CacheFirst',
            options: { cacheName: 'ocr', expiration: { maxEntries: 8 } },
          },
        ],
      },
    }),
  ],
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 30000,
  },
});
