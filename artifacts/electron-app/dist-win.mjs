import { execSync } from 'child_process';

process.env.CSC_IDENTITY_AUTO_DISCOVERY = 'false';

execSync(
  'electron-builder --win --config electron-builder.config.js',
  { stdio: 'inherit' }
);
