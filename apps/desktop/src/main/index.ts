// Entry point. Owns the BrowserWindow, wires IPC, and holds the only
// references to @helm/engine and @helm/shell. Nothing below src/renderer may
// import either package — enforced by the boundary check in scripts/.

import { app, BrowserWindow, Menu, nativeTheme, shell } from 'electron';
import { join } from 'node:path';
import { loadEnv } from './env.js';
import { killAllSessions, registerIpc } from './ipc.js';

/** Matches the renderer's --helm-bg so there is no white flash on show. */
const BACKGROUND = '#0d1017';

const env = loadEnv(app.getAppPath());

let mainWindow: BrowserWindow | null = null;

/**
 * A terminal without Cmd+C / Cmd+V is not a terminal, so the menu is trimmed
 * rather than removed. Everything that would only add clutter is gone.
 */
function buildMenu(): void {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: 'Helm',
        submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'hide' }, { role: 'quit' }],
      },
      {
        label: 'Edit',
        submenu: [
          { role: 'copy' },
          { role: 'paste' },
          { role: 'selectAll' },
          { type: 'separator' },
          {
            label: 'Clear Scrollback',
            accelerator: 'CmdOrCtrl+K',
            click: () => mainWindow?.webContents.send('helm:clear'),
          },
        ],
      },
      {
        label: 'View',
        submenu: [{ role: 'togglefullscreen' }, { role: 'toggleDevTools' }],
      },
      { role: 'windowMenu' },
    ]),
  );
}

function createWindow(): void {
  nativeTheme.themeSource = 'dark';

  mainWindow = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 520,
    minHeight: 320,
    show: false,
    backgroundColor: BACKGROUND,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 14 },
    webPreferences: {
      // Non-negotiable: the renderer reaches nothing directly.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: join(__dirname, '../preload/index.cjs'),
    },
  });

  mainWindow.on('ready-to-show', () => mainWindow?.show());
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // External links open in the browser, never inside the app frame.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) void shell.openExternal(url);
    return { action: 'deny' };
  });

  registerIpc(mainWindow, env);

  const devUrl = process.env['ELECTRON_RENDERER_URL'];
  if (devUrl) {
    void mainWindow.loadURL(devUrl);
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

app.whenReady().then(() => {
  buildMenu();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// Phase 5 keeps the app alive in the Dock. Until then, closing the window
// quits, which is what a terminal is expected to do.
app.on('window-all-closed', () => {
  killAllSessions();
  if (process.platform !== 'darwin') app.quit();
  else app.quit();
});

app.on('before-quit', killAllSessions);
