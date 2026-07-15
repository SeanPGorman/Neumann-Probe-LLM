import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');

function run(cmd, cwd = root) {
  console.log(`\n▶ ${cmd}`);
  execSync(cmd, { stdio: 'inherit', cwd });
}

function copyDir(src, dest) {
  if (!fs.existsSync(src)) throw new Error(`Source not found: ${src}`);
  fs.mkdirSync(dest, { recursive: true });
  fs.cpSync(src, dest, { recursive: true });
}

// ── Step 1: Build API server ──────────────────────────────────────────────────
console.log('=== Step 1/4 — Build API server ===');
run('pnpm --filter @workspace/api-server run build');

// ── Step 2: Build frontend ────────────────────────────────────────────────────
console.log('\n=== Step 2/4 — Build frontend ===');
run('pnpm --filter @workspace/probe-commander run build');

// ── Step 3: Build Electron main process ──────────────────────────────────────
console.log('\n=== Step 3/4 — Build Electron wrapper ===');
run('node build.mjs', here);

// ── Step 4: Package with @electron/packager (no signing, no winCodeSign) ─────
console.log('\n=== Step 4/4 — Package Windows app ===');

const releaseDir = path.join(here, 'release');

// @electron/packager has no signing infrastructure — winCodeSign is never touched
const { default: packager } = await import('@electron/packager');

const appPaths = await packager({
  dir: here,
  name: 'Probe Commander',
  platform: 'win32',
  arch: 'x64',
  out: releaseDir,
  overwrite: true,
  electronVersion: '31.7.7',
  asar: true,
  // Exclude source/build-tool files; keep dist/ (the compiled app)
  ignore: [
    /^\/src\b/,
    /^\/release\b/,
    /^\/node_modules\b/,
    /build\.mjs$/,
    /dist-win\.mjs$/,
    /electron-builder/,
    /tsconfig/,
    /\.ts$/,
  ],
  prune: true,
});

const outDir = appPaths[0]; // e.g. release/Probe Commander-win32-x64
const resourcesDir = path.join(outDir, 'resources');

// Copy api-server and frontend builds into resources/ so main.ts can find them
// via process.resourcesPath at runtime
console.log('\n• Copying API server build into resources...');
copyDir(
  path.join(root, 'artifacts', 'api-server', 'dist'),
  path.join(resourcesDir, 'api-server', 'dist')
);

console.log('• Copying frontend build into resources...');
copyDir(
  path.join(root, 'artifacts', 'probe-commander', 'dist', 'public'),
  path.join(resourcesDir, 'probe-commander', 'dist', 'public')
);

// ── Zip with PowerShell (built into every modern Windows) ─────────────────────
const zipPath = path.join(releaseDir, 'Probe-Commander-win.zip');
console.log(`\n• Creating zip: ${zipPath}`);
if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);

execSync(
  `powershell -NoProfile -Command "Compress-Archive -Path '${outDir}' -DestinationPath '${zipPath}' -Force"`,
  { stdio: 'inherit' }
);

console.log('\n✓ Done!');
console.log(`  Output: ${zipPath}`);
console.log('  Extract the zip, open the "Probe Commander-win32-x64" folder, and double-click "Probe Commander.exe"');
