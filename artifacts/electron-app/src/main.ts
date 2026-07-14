import { app, BrowserWindow, ipcMain, Menu, shell } from 'electron';
import path from 'path';
import fs from 'fs';
import { pathToFileURL } from 'url';
import { EventEmitter } from 'events';

interface AppConfig {
  vngApiKey: string;
  aiBaseUrl: string;
  aiApiKey: string;
}

const CONFIG_FILE = path.join(app.getPath('userData'), 'probe-commander-config.json');
const bus = new EventEmitter();

let mainWindow: BrowserWindow | null = null;
let settingsWindow: BrowserWindow | null = null;
let serverStarted = false;

// ── Config helpers ────────────────────────────────────────────────────────────

function readConfig(): Partial<AppConfig> {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    }
  } catch {}
  return {};
}

function writeConfig(cfg: AppConfig): void {
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8');
}

function isComplete(cfg: Partial<AppConfig>): cfg is AppConfig {
  return !!(cfg.vngApiKey && cfg.aiBaseUrl && cfg.aiApiKey);
}

// ── IPC handlers (registered once at module level) ────────────────────────────

ipcMain.handle('load-config', () => readConfig());

ipcMain.handle('save-config', (_event, cfg: AppConfig) => {
  writeConfig(cfg);
  bus.emit('config-saved', cfg);
  return { ok: true };
});

// ── Server ────────────────────────────────────────────────────────────────────

function resourcesPath(): string {
  // In packaged app: process.resourcesPath is the resources/ folder next to the asar.
  // In dev (electron . from repo root or electron-app/): walk up to artifacts/.
  return app.isPackaged
    ? process.resourcesPath
    : path.join(__dirname, '..', '..'); // dist/ → electron-app/ → artifacts/
}

async function startApiServer(cfg: AppConfig): Promise<void> {
  if (serverStarted) return;
  serverStarted = true;

  const rp = resourcesPath();
  const frontendPath = path.join(rp, 'probe-commander', 'dist', 'public');
  const apiServerEntry = path.join(rp, 'api-server', 'dist', 'index.mjs');

  // Inject credentials and config as environment variables before importing
  process.env['PORT'] = '8080';
  process.env['NODE_ENV'] = 'production';
  process.env['VNG_API_KEY'] = cfg.vngApiKey;
  process.env['AI_INTEGRATIONS_OPENAI_BASE_URL'] = cfg.aiBaseUrl;
  process.env['AI_INTEGRATIONS_OPENAI_API_KEY'] = cfg.aiApiKey;

  if (fs.existsSync(frontendPath)) {
    process.env['FRONTEND_STATIC_DIR'] = frontendPath;
  }

  if (!fs.existsSync(apiServerEntry)) {
    throw new Error(
      `API server not built. Run:\n  pnpm --filter @workspace/api-server run build\n\nExpected: ${apiServerEntry}`
    );
  }

  await import(pathToFileURL(apiServerEntry).href);
}

// ── Windows ───────────────────────────────────────────────────────────────────

function createSettingsWindow(): void {
  if (settingsWindow) {
    settingsWindow.focus();
    return;
  }

  settingsWindow = new BrowserWindow({
    width: 540,
    height: 680,
    resizable: false,
    backgroundColor: '#0a0e0a',
    title: 'Probe Commander — Setup',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  settingsWindow.setMenuBarVisibility(false);
  settingsWindow.loadFile(path.join(__dirname, 'settings.html'));
  settingsWindow.on('closed', () => { settingsWindow = null; });
}

function createMainWindow(): void {
  if (mainWindow) {
    mainWindow.show();
    mainWindow.focus();
    return;
  }

  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1000,
    minHeight: 600,
    backgroundColor: '#0a0e0a',
    title: 'Probe Commander',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  buildMenu();
  mainWindow.loadURL('http://localhost:8080');
  mainWindow.on('closed', () => { mainWindow = null; });
}

function buildMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: 'Probe Commander',
      submenu: [
        {
          label: 'Credentials & Settings…',
          click: () => createSettingsWindow(),
        },
        { type: 'separator' },
        {
          label: 'Reload',
          accelerator: 'CmdOrCtrl+R',
          click: () => mainWindow?.webContents.reload(),
        },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
      ],
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'neumann-probe.net',
          click: () => shell.openExternal('https://neumann-probe.net'),
        },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ── App lifecycle ─────────────────────────────────────────────────────────────

app.whenReady().then(async () => {
  let config = readConfig();

  if (!isComplete(config)) {
    createSettingsWindow();
    config = await new Promise<AppConfig>((resolve) => {
      bus.once('config-saved', (cfg: AppConfig) => {
        settingsWindow?.close();
        resolve(cfg);
      });
    });
  }

  if (isComplete(config)) {
    try {
      await startApiServer(config);
    } catch (err: unknown) {
      const { dialog } = await import('electron');
      dialog.showErrorBox(
        'Could not start server',
        err instanceof Error ? err.message : String(err)
      );
      app.quit();
      return;
    }

    // Poll until the server is listening before opening the window
    await waitForServer('http://localhost:8080', 10_000);
    createMainWindow();
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (!mainWindow && !settingsWindow) {
    const config = readConfig();
    if (isComplete(config)) createMainWindow();
  }
});

// ── Helpers ───────────────────────────────────────────────────────────────────

async function waitForServer(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fetch(url, { signal: AbortSignal.timeout(1000) });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  throw new Error(`Server at ${url} did not respond within ${timeoutMs}ms`);
}
