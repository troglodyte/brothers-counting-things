// Render the PWA PNG icons from public/icon.svg (run automatically by `npm run build`).
import sharp from 'sharp';

for (const size of [192, 512]) {
  await sharp('public/icon.svg', { density: 300 }).resize(size, size).png().toFile(`public/icon-${size}.png`);
}
console.log('icons: wrote public/icon-192.png, public/icon-512.png');
