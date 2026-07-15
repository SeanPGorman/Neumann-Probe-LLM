import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');

function run(cmd, cwd = root) {
  console.log(`\n▶ ${cmd}`);
  execSync(cmd, { stdio: 'inherit', cwd });
}

// Disable code-signing so electron-builder never touches winCodeSign
// (which fails on Windows without Developer Mode due to macOS symlinks inside the archive)
process.env.CSC_IDENTITY_AUTO_DISCOVERY = 'false';

console.log('=== Step 1/4 — Build API server ===');
run('pnpm --filter @workspace/api-server run build');

console.log('\n=== Step 2/4 — Build frontend ===');
run('pnpm --filter @workspace/probe-commander run build');

console.log('\n=== Step 3/4 — Build Electron wrapper ===');
run('node build.mjs', here);

console.log('\n=== Step 4/4 — Package Windows installer ===');
run('electron-builder --win --config electron-builder.config.js', here);

console.log('\n✓ Done — installer is in artifacts/electron-app/release/');
