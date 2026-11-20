const { app, BrowserWindow, dialog, ipcMain, net, protocol } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { fileURLToPath, pathToFileURL } = require('node:url');
const { loadProfile, listSources, listActions, saveLayout, verifyLayout, applyNextLaunch } = require('../game/profile.cjs');
const { getActiveFileState, restoreActiveFile } = require('../game/active-files.cjs');
const { startInput } = require('../input');

const root = path.resolve(__dirname, '../..');
const defaultLive = path.join(
  process.env.ProgramFiles || 'C:\\Program Files',
  'Roberts Space Industries',
  'StarCitizen',
  'LIVE',
);
const mappingDirectory = 'USER/Client/0/Controls/Mappings';
const compatibilityMode = process.argv.includes('--compatibility-mode');
let livePath;
let scanDevicesByRig;
let window;
let stopInput;
let saving = false;
let devices = [];
let status = { level: 'info', message: compatibilityMode
  ? 'Compatibility mode · software graphics and mouse editing. Live joystick input is off.'
  : 'Starting Windows input reader' };

const appName = 'HOTAS Uplink';
app.setName(appName);
// Electron stores the viewer's three display preferences by profile directory and origin.
// Reuse both for an existing installation, without copying its Chromium data.
function chooseAssetScheme() {
  const userData = app.getPath('userData');
  const appData = app.getPath('appData');
  const hasPreferences = dir => fs.existsSync(path.join(dir, 'installation.json')) ||
    fs.existsSync(path.join(dir, 'Local Storage', 'leveldb', 'CURRENT'));
  if (app.commandLine.hasSwitch('user-data-dir') || path.dirname(userData) !== appData ||
      path.basename(userData) !== appName || app.getPath('sessionData') !== userData || hasPreferences(userData)) {
    return 'hotas-uplink';
  }
  for (const previousName of ['VKBTOOL', 'deltawerks-vkbtool']) {
    const previous = path.join(appData, previousName);
    if (!hasPreferences(previous)) continue;
    app.setPath('userData', previous);
    app.setPath('sessionData', previous);
    return 'vkbtool';
  }
  return 'hotas-uplink';
}
const assetScheme = chooseAssetScheme();
const viewerUrl = assetScheme + '://app/src/ui/index.html';
if (compatibilityMode) {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('use-gl', 'angle');
  app.commandLine.appendSwitch('use-angle', 'swiftshader');
}
protocol.registerSchemesAsPrivileged([
  {
    scheme: assetScheme,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  },
]);

function serveAssets(request) {
  const url = new URL(request.url);
  if (url.hostname !== 'app') return new Response(null, { status: 404 });
  let relative;
  try {
    relative = decodeURIComponent(url.pathname).replace(/^\/+/, '');
  } catch {
    return new Response(null, { status: 400 });
  }
  const allowed = ['src/ui/', 'src/rig/', 'assets/', 'node_modules/three/'];
  if (
    relative.includes('\\') ||
    relative.includes(':') ||
    relative.split('/').includes('..') ||
    !allowed.some((prefix) => relative.startsWith(prefix))
  )
    return new Response(null, { status: 404 });
  return net.fetch(pathToFileURL(path.join(root, relative)).href);
}

function getLivePath() {
  if (process.env.HOTAS_UPLINK_LIVE) return path.resolve(process.env.HOTAS_UPLINK_LIVE);
  try {
    const selected = JSON.parse(
      fs.readFileSync(path.join(app.getPath('userData'), 'installation.json'), 'utf8'),
    );
    if (typeof selected.path === 'string') return selected.path;
  } catch {
    /* Use the usual installation on first launch. */
  }
  return defaultLive;
}

async function listLayouts() {
  const sources = await listSources(livePath);
  return sources
    .filter((s) => s.kind === 'export' || s.kind === 'builtin')
    .map((s) => ({
      id: s.kind === 'builtin' ? s.path : 'export:' + path.basename(s.path),
      kind: s.kind,
      name: s.name,
    }));
}

ipcMain.handle('viewer:state', () => ({
  livePath, devices, status, compatibilityMode, scanDevicesByRig, startEditing: process.argv.includes('--edit-layout'),
}));
ipcMain.handle('viewer:sources', listLayouts);
function sourceOptions(id) {
  if (typeof id !== 'string') throw new Error('Invalid layout source.');
  if (id === 'active') return { livePath };
  if (id === 'blank') return { livePath, blank: true };
  if (id.startsWith('builtin:')) {
    const key = id.slice(8);
    if (!['gnx', 'scg'].includes(key)) throw new Error('Unknown game preset.');
    return { livePath, profilePath: id };
  }
  if (!id.startsWith('export:')) throw new Error('Unknown layout.');
  const filename = id.slice(7);
  if (
    !filename ||
    path.basename(filename) !== filename ||
    /[:/\\]/.test(filename) ||
    !/\.xml$/i.test(filename)
  )
    throw new Error('Invalid layout filename.');
  return { livePath, profilePath: path.join(livePath, mappingDirectory, filename) };
}
ipcMain.handle('viewer:profile', (_event, id = 'active') => loadProfile(sourceOptions(id)));
ipcMain.handle('viewer:actions', (_event, id) => listActions(sourceOptions(id)));
ipcMain.handle('viewer:verify-layout', (_event, id, expectedRevision) => {
  if (typeof id !== 'string' || !id.startsWith('export:')) throw new Error('Choose a saved layout to check.');
  return verifyLayout({ ...sourceOptions(id), expectedRevision });
});
async function writeProfile(operation) {
  if (saving) throw new Error('A layout change is already in progress. Wait for it to finish.');
  saving = true;
  try {
    return await operation();
  } finally {
    saving = false;
  }
}
function requireInstallation(installation) {
  if (installation !== livePath) throw new Error('The game installation changed. Open the confirmation again.');
}
ipcMain.handle('viewer:save-layout', (_event, { source, expectedRevision, name, edits, devices, emptySource }) => {
  const options = sourceOptions(source);
  if (emptySource && source === 'active') options.blank = true;
  return writeProfile(() => saveLayout({ ...options, expectedRevision, name, edits, devices }));
});
ipcMain.handle('viewer:next-launch-status', async () => {
  const installation = livePath;
  return { ...await getActiveFileState(installation), installation };
});
ipcMain.handle('viewer:apply-next-launch', (_event, { source, expectedRevision, expectedActiveRevision, installation }) => {
  requireInstallation(installation);
  return writeProfile(() => applyNextLaunch({ ...sourceOptions(source), expectedRevision, expectedActiveRevision }));
});
ipcMain.handle('viewer:restore-previous-bindings', (_event, { expectedActiveRevision, backupId, installation }) => {
  requireInstallation(installation);
  return writeProfile(() => restoreActiveFile({ livePath, expectedActiveRevision, backupId }));
});
ipcMain.handle('viewer:choose-install', async () => {
  if (saving) throw new Error('Wait for the layout change to finish before switching installations.');
  const result = await dialog.showOpenDialog(window, {
    title: 'Choose Star Citizen LIVE folder',
    defaultPath: livePath,
    properties: ['openDirectory'],
  });
  if (result.canceled) return null;
  if (saving) throw new Error('Wait for the layout change to finish before switching installations.');
  const selected = result.filePaths[0];
  if (
    !fs.existsSync(path.join(selected, 'Data.p4k')) &&
    !fs.existsSync(path.join(selected, 'USER/Client/0'))
  ) {
    throw new Error('Choose the game folder containing Data.p4k or USER/Client/0.');
  }
  const target = path.join(app.getPath('userData'), 'installation.json');
  fs.writeFileSync(target + '.tmp', JSON.stringify({ path: selected }), 'utf8');
  fs.renameSync(target + '.tmp', target);
  livePath = selected;
  return selected;
});

function receiveInput(event) {
  if (event.type === 'devices') devices = event.devices;
  if (event.type === 'status') status = { level: event.level, message: event.message };
  if (window && !window.isDestroyed() && !window.webContents.isDestroyed())
    window.webContents.send('viewer:input', event);
}

async function openWindow() {
  const { modelAssetsByRig } = await import('../rig/model-assets.mjs');
  scanDevicesByRig = Object.fromEntries(Object.entries(modelAssetsByRig).map(([id, assets]) => [
    id, Object.keys(assets).filter(device => fs.existsSync(fileURLToPath(assets[device]))),
  ]));
  protocol.handle(assetScheme, serveAssets);
  livePath = getLivePath();
  window = new BrowserWindow({
    title: appName,
    icon: path.join(root, 'assets/brand/app.ico'),
    width: 1580,
    height: 990,
    minWidth: 900,
    minHeight: 620,
    backgroundColor: '#050b17',
    autoHideMenuBar: true,
    show: false,
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#09111e', symbolColor: '#c4d5ec', height: 48 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  window.setMenu(null);
  window.on('close', event => { if (saving) event.preventDefault(); });
  window.webContents.on('will-prevent-unload', (event) => {
    if (saving) return;
    const choice = dialog.showMessageBoxSync(window, {
      type: 'question', buttons: ['Keep editing', 'Discard edits'], defaultId: 0, cancelId: 0,
      message: 'Discard the unsaved layout changes?',
    });
    if (choice === 1) event.preventDefault();
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => {
    if (url !== viewerUrl) event.preventDefault();
  });
  window.once('ready-to-show', () => window.show());
  if (!compatibilityMode) {
    try {
      stopInput = startInput(receiveInput);
    } catch (error) {
      receiveInput({ type: 'status', level: 'error', message: error.message });
    }
  }
  await window.loadURL(viewerUrl);
}

if (app.requestSingleInstanceLock({ compatibilityMode })) {
  app.on('second-instance', (_event, _argv, _cwd, request) => {
    if (!window || window.isDestroyed()) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
    if (typeof request?.compatibilityMode === 'boolean' && request.compatibilityMode !== compatibilityMode) {
      dialog.showMessageBox(window, {
        type: 'info',
        message: appName + (compatibilityMode ? ' is open in compatibility mode.' : ' is open in standard mode.'),
        detail: 'Finish any edits, close this window, then open the launcher for the mode you want.',
      });
    }
  });
  app.whenReady().then(openWindow);
} else {
  app.quit();
}
app.on('window-all-closed', () => app.quit());
app.on('before-quit', event => { if (saving) event.preventDefault(); });
app.on('will-quit', () => {
  if (stopInput) stopInput();
});
