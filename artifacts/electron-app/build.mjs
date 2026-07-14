import { build } from 'esbuild';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const src = (f) => path.join(__dirname, 'src', f);
const dist = (f) => path.join(__dirname, 'dist', f);

fs.mkdirSync(dist(''), { recursive: true });

const common = {
  bundle: true,
  platform: 'node',
  external: ['electron'],
  format: 'cjs',
  sourcemap: true,
};

await Promise.all([
  build({ ...common, entryPoints: [src('main.ts')], outfile: dist('main.js') }),
  build({ ...common, entryPoints: [src('preload.ts')], outfile: dist('preload.js') }),
]);

fs.copyFileSync(src('settings.html'), dist('settings.html'));

console.log('Electron build done.');
