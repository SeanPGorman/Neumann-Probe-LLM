module.exports = {
  appId: 'net.neumann-probe.probe-commander',
  productName: 'Probe Commander',
  directories: { output: 'release' },
  files: [
    'dist/**',
    '!node_modules',
  ],
  extraResources: [
    {
      from: '../api-server/dist',
      to: 'api-server/dist',
      filter: ['**/*'],
    },
    {
      from: '../probe-commander/dist/public',
      to: 'probe-commander/dist/public',
      filter: ['**/*'],
    },
  ],
  mac: {
    target: [{ target: 'dmg' }, { target: 'zip' }],
    category: 'public.app-category.utilities',
  },
  win: {
    target: [{ target: 'nsis', arch: ['x64'] }],
    // No-op sign function: bypasses electron-builder's built-in signing
    // infrastructure (winCodeSign), which fails on Windows without Developer
    // Mode due to macOS symlinks inside the downloaded archive.
    sign: () => {},
  },
  linux: {
    target: [{ target: 'AppImage', arch: ['x64'] }],
    category: 'Utility',
  },
  nsis: {
    oneClick: false,
    allowToChangeInstallationDirectory: true,
    installerIcon: null,
    uninstallerIcon: null,
  },
};
