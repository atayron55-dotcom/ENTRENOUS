'use strict';

const { app, BrowserWindow, Menu, ipcMain, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const APP_NAME = 'Entre Nous';
// Les builds Windows portable et Linux AppImage gardent leurs données à côté du binaire
// quand le dossier est accessible en écriture. Les builds installés utilisent userData.
const portableDirectory = process.env.PORTABLE_EXECUTABLE_DIR || (process.env.APPIMAGE ? path.dirname(process.env.APPIMAGE) : '');
if (portableDirectory) {
  try {
    const portableDataPath = path.join(portableDirectory, 'EntreNousData');
    fs.mkdirSync(portableDataPath, { recursive: true });
    app.setPath('userData', portableDataPath);
  } catch { /* fallback vers le dossier utilisateur standard */ }
}
const SETTINGS_PATH = path.join(app.getPath('userData'), 'settings.json');
let mainWindow;

function readDefaultSignalUrl() {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(__dirname, 'default-config.json'), 'utf8'));
    const value = typeof parsed.signalUrl === 'string' ? parsed.signalUrl.trim() : '';
    return value.includes('VOTRE-') ? '' : value;
  } catch { return ''; }
}

function readSettings() {
  const defaultSignalUrl = readDefaultSignalUrl();
  try {
    const parsed = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
    return {
      signalUrl: typeof parsed.signalUrl === 'string' && parsed.signalUrl ? parsed.signalUrl : defaultSignalUrl,
      turnUrl: typeof parsed.turnUrl === 'string' ? parsed.turnUrl : '',
      turnUsername: typeof parsed.turnUsername === 'string' ? parsed.turnUsername : '',
      turnCredential: typeof parsed.turnCredential === 'string' ? parsed.turnCredential : ''
    };
  } catch {
    return { signalUrl: defaultSignalUrl, turnUrl: '', turnUsername: '', turnCredential: '' };
  }
}

function writeSettings(value) {
  if (!value || typeof value.signalUrl !== 'string' || value.signalUrl.length > 500) {
    throw new Error('Adresse du service de mise en relation invalide.');
  }
  let parsed;
  try { parsed = new URL(value.signalUrl.trim()); }
  catch { throw new Error('Saisis une adresse WebSocket valide, par exemple wss://signal.exemple.fr'); }
  if (!['wss:', 'ws:'].includes(parsed.protocol)) {
    throw new Error('L’adresse doit commencer par wss:// (ou ws:// pour un test local).');
  }
  if (parsed.protocol === 'ws:' && !['localhost', '127.0.0.1', '::1'].includes(parsed.hostname)) {
    throw new Error('Pour Internet, utilise une adresse sécurisée wss://. ws:// est réservé aux tests locaux.');
  }
  const turnUrl = typeof value.turnUrl === 'string' ? value.turnUrl.trim().slice(0, 500) : '';
  if (turnUrl && !/^turns?:[^\s]+$/i.test(turnUrl)) throw new Error('Adresse TURN invalide. Exemple : turns:turn.example.com:5349');
  const settings = {
    signalUrl: parsed.toString().replace(/\/$/, ''),
    turnUrl,
    turnUsername: typeof value.turnUsername === 'string' ? value.turnUsername.slice(0, 200) : '',
    turnCredential: typeof value.turnCredential === 'string' ? value.turnCredential.slice(0, 500) : ''
  }; 
  fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true });
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2), { mode: 0o600 });
  return settings;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 850,
    minHeight: 650,
    title: APP_NAME,
    backgroundColor: '#17151d',
    autoHideMenuBar: process.platform !== 'darwin',
    show: false,
    icon: path.join(__dirname, 'assets', process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false
    }
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => { mainWindow = null; });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const target = new URL(url);
      if (target.protocol === 'https:') shell.openExternal(url);
    } catch { /* ignore invalid URL */ }
    return { action: 'deny' };
  });
  const localPage = require('node:url').pathToFileURL(path.join(__dirname, 'index.html')).href;
  mainWindow.webContents.on('will-navigate', (event, destination) => {
    if (destination !== localPage) event.preventDefault();
  });
  mainWindow.webContents.on('will-attach-webview', (event) => event.preventDefault());
  mainWindow.loadFile(path.join(__dirname, 'index.html'));
}

ipcMain.handle('entre-nous:get-settings', (event) => {
  if (!event.senderFrame?.isMainFrame) throw new Error('Action non autorisée.');
  return readSettings();
});
ipcMain.handle('entre-nous:save-settings', (event, value) => {
  if (!event.senderFrame?.isMainFrame) throw new Error('Action non autorisée.');
  return writeSettings(value);
});
ipcMain.handle('entre-nous:open-external', async (event, url) => {
  if (!event.senderFrame?.isMainFrame || typeof url !== 'string') throw new Error('Action non autorisée.');
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:') throw new Error('Seuls les liens HTTPS sont autorisés.');
  await shell.openExternal(parsed.toString());
  return { ok: true };
});

app.whenReady().then(() => {
  if (process.platform === 'win32') app.setAppUserModelId('fr.entre-nous.p2p');
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(process.platform === 'darwin' ? [{ label: APP_NAME, submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'quit' }] }] : []),
    { label: 'Fichier', submenu: [{ label: 'Paramètres', accelerator: 'CmdOrCtrl+,', click: () => mainWindow?.webContents.send('entre-nous:open-settings') }, { type: 'separator' }, { role: 'quit' }] },
    { label: 'Édition', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: 'Fenêtre', submenu: [{ role: 'minimize' }, { role: 'close' }] }
  ]));
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
