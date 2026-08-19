// Entry point. Owns the BrowserWindow, wires IPC, and holds the only
// references to @helm/engine and @helm/shell. Nothing below src/renderer may
// import either package — enforced by the boundary check in scripts/.

import { app, BrowserWindow, globalShortcut, Menu, nativeImage, nativeTheme, shell } from 'electron';
import { join } from 'node:path';
import { loadEnv } from './env.js';
import { disposeAgent, killAllSessions, registerIpc } from './ipc.js';

/** Matches the renderer's --helm-bg so there is no white flash on show. */
const BACKGROUND = '#0d1017';

// Identity. Without this a dev run reports itself as "Electron" in the menu
// bar, the Dock, and the About panel, because `electron .` launches the stock
// binary and inherits its Info.plist. The packaged build takes its name from
// electron-builder's productName, so this only matters for `pnpm dev` — but
// "the menu bar says Electron" is a chrome defect either way.
app.setName('Helm');

// A terminal that stops repainting because another window covers it is a
// terminal that lies about what the shell has printed. macOS occlusion
// detection marks a covered window hidden and Chromium then throttles the
// renderer, so output only appears once you look at it again. Keep the
// renderer scheduled regardless.
app.commandLine.appendSwitch('disable-features', 'MacWebContentsOcclusion');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-renderer-backgrounding');

const env = loadEnv(app.getAppPath());

let mainWindow: BrowserWindow | null = null;

/**
 * Closing the window hides it rather than quitting. A terminal you have to
 * cold-start is not "always available" — the shell keeps running behind the
 * hidden window, so Cmd+Shift+H brings back the session you left, scrollback
 * and all. Only an explicit quit tears anything down.
 */
let isQuitting = false;

const HOTKEY = 'CommandOrControl+Shift+H';

function toggleWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    return;
  }
  if (mainWindow.isVisible() && mainWindow.isFocused()) {
    mainWindow.hide();
  } else {
    mainWindow.show();
    mainWindow.focus();
  }
}

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
        submenu: [
          { role: 'togglefullscreen' },
          { role: 'toggleDevTools' },
          { type: 'separator' },
          { label: 'Hide Helm', accelerator: HOTKEY, click: toggleWindow },
        ],
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

  mainWindow.on('close', (event) => {
    // Hide instead of closing, unless the user is genuinely quitting.
    if (!isQuitting && mainWindow && !mainWindow.isDestroyed()) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // External links open in the browser, never inside the app frame.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) void shell.openExternal(url);
    return { action: 'deny' };
  });


  const devUrl = process.env['ELECTRON_RENDERER_URL'];
  if (devUrl) {
    void mainWindow.loadURL(devUrl);
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

app.whenReady().then(() => {
  // Packaged builds take the icon from the bundle's Info.plist. A dev run
  // launches the stock Electron binary and would otherwise sit in the Dock
  // wearing Electron's icon, which is exactly the "it's just Electron"
  // problem — so set it explicitly.
  if (!app.isPackaged && app.dock) {
    const icon = nativeImage.createFromPath(join(app.getAppPath(), 'build', 'icon.png'));
    if (!icon.isEmpty()) app.dock.setIcon(icon);
  }

  app.setAboutPanelOptions({
    applicationName: 'Helm',
    applicationVersion: app.getVersion(),
    version: '',
    credits: 'A shell and the Claude agent loop behind one prompt.',
  });

  buildMenu();
  // Once for the app, before any window exists.
  registerIpc(() => mainWindow, env);
  createWindow();

  if (!globalShortcut.register(HOTKEY, toggleWindow)) {
    // Another app owns it. Say so rather than failing silently — the menu item
    // still works.
    console.error(`[helm] could not register ${HOTKEY}; it is already taken.`);
  }

  app.on('activate', () => {
    if (!mainWindow || mainWindow.isDestroyed()) createWindow();
    else mainWindow.show();
  });
});

// The app stays resident on macOS: the window hides, the shell keeps running,
// and the Dock icon is how you get back to it.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    killAllSessions();
    void disposeAgent();
    app.quit();
  }
});

app.on('before-quit', () => {
  isQuitting = true;
  killAllSessions();
  void disposeAgent();
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});
