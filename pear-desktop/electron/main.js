/**
 * Electron main — Pear desktop shell.
 * Mirrors hello-pear-electron: pear-runtime Bare workers, OTA apply, storage flags.
 * Game P2P lives in the Bare worker; main only bridges IPC.
 */
const { app, BrowserWindow, ipcMain } = require('electron')
const os = require('os')
const path = require('path')
const PearRuntime = require('pear-runtime')
const FramedStream = require('framed-stream')
const { isMac, isLinux, isWindows } = require('which-runtime')
const { command, flag } = require('paparam')
const pkg = require('../package.json')

const { name, productName, version, upgrade } = pkg
const protocol = name
const mainWorkerSpecifier = '/workers/main.js'
const workers = new Map()
const appName = productName ?? name

const cmd = command(
  appName,
  flag('--storage <dir>', 'pass custom storage to pear-runtime'),
  flag('--no-updates', 'start without OTA updates'),
  flag('--updates', 'enable OTA updates'),
  flag('--dev', 'open DevTools'),
  flag('--no-sandbox', 'start without Chromium sandbox').hide(),
)

cmd.parse(app.isPackaged ? process.argv.slice(1) : process.argv.slice(2))

const pearStore = cmd.flags.storage
// Dev default (npm start) passes --no-updates. Explicit --updates enables OTA.
const updatesEnabled = process.argv.includes('--updates')
  ? true
  : process.argv.includes('--no-updates')
    ? false
    : false

if (pearStore) app.setPath('userData', pearStore)

ipcMain.on('pkg', (evt) => {
  evt.returnValue = pkg
})

function getAppPath() {
  if (!app.isPackaged) return null
  if (isLinux && process.env.APPIMAGE) return process.env.APPIMAGE
  if (isWindows) return process.execPath
  return path.join(process.resourcesPath, '..', '..')
}

function sendToAll(channel, data) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, data)
  }
}

function resolveStorageDir() {
  if (pearStore) {
    console.log('pear store:', pearStore)
    return pearStore
  }
  if (getAppPath() === null) {
    return path.join(os.tmpdir(), 'pear', appName)
  }
  const isSnap = !!process.env.SNAP_USER_COMMON
  const linuxConfigHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config')
  if (isMac) return path.join(os.homedir(), 'Library', 'Application Support', appName)
  if (isLinux) {
    return isSnap
      ? path.join(process.env.SNAP_USER_COMMON, appName)
      : path.join(linuxConfigHome, appName)
  }
  return path.join(os.homedir(), 'AppData', 'Roaming', appName)
}

function getWorker(specifier) {
  if (workers.has(specifier)) return workers.get(specifier)

  const dir = resolveStorageDir()
  const extension = isLinux ? '.AppImage' : isMac ? '.app' : '.msix'
  const appPath = getAppPath()

  // PearRuntime.run executes workers/main.js inside embedded Bare
  const workerEntry = require.resolve('..' + specifier)
  const worker = PearRuntime.run(workerEntry, [
    String(updatesEnabled),
    version,
    upgrade,
    productName + extension,
    dir,
    appPath,
  ])
  const pipe = new FramedStream(worker)

  function sendWorkerStdout(data) {
    sendToAll('pear:worker:stdout:' + specifier, data)
  }
  function sendWorkerStderr(data) {
    sendToAll('pear:worker:stderr:' + specifier, data)
  }
  function sendWorkerIPC(data) {
    sendToAll('pear:worker:ipc:' + specifier, data)
  }
  function onBeforeQuit() {
    try {
      pipe.destroy()
    } catch {
      /* ignore */
    }
  }

  ipcMain.handle('pear:worker:writeIPC:' + specifier, (_evt, data) => {
    return pipe.write(data)
  })

  function onStdout(data) {
    process.stdout.write('[worker stdout] ' + data)
    sendWorkerStdout(data)
  }
  function onStderr(data) {
    process.stderr.write('[worker stderr] ' + data)
    sendWorkerStderr(data)
  }

  workers.set(specifier, pipe)
  pipe.on('data', sendWorkerIPC)
  worker.stdout.on('data', onStdout)
  worker.stderr.on('data', onStderr)
  worker.once('exit', (code) => {
    console.error('[worker exit]', specifier, code)
    app.removeListener('before-quit', onBeforeQuit)
    ipcMain.removeHandler('pear:worker:writeIPC:' + specifier)
    pipe.removeListener('data', sendWorkerIPC)
    worker.stdout.removeListener('data', onStdout)
    worker.stderr.removeListener('data', onStderr)
    sendToAll('pear:worker:exit:' + specifier, code)
    workers.delete(specifier)
  })
  app.on('before-quit', onBeforeQuit)
  return pipe
}

async function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 640,
    title: appName,
    backgroundColor: '#0e0b09',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      sandbox: true,
      nodeIntegration: false,
      contextIsolation: true,
      // Same React game as the web client (3D board, animations, audio)
      webSecurity: true,
    },
  })

  // Prefer Vite React app (same as browser). Fall back to packaged parent dist.
  const devServerUrl =
    process.env.PEAR_DEV_SERVER_URL ||
    (!app.isPackaged ? 'http://127.0.0.1:5173' : null)

  if (devServerUrl) {
    try {
      await win.loadURL(devServerUrl)
    } catch (err) {
      console.error('Failed to load React dev server at', devServerUrl, err)
      console.error('Start Vite from repo root: pnpm dev --host 127.0.0.1 --port 5173')
      const distHtml = path.join(__dirname, '..', '..', 'dist', 'index.html')
      await win.loadFile(distHtml)
    }
  } else {
    const distHtml = path.join(__dirname, '..', '..', 'dist', 'index.html')
    await win.loadFile(distHtml)
  }

  if (!app.isPackaged && process.argv.includes('--dev')) {
    win.webContents.openDevTools({ mode: 'detach' })
  }
}

ipcMain.handle('pear:applyUpdate', () => {
  const pipe = getWorker(mainWorkerSpecifier)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pipe.removeListener('data', onData)
      reject(new Error('applyUpdate timeout'))
    }, 60_000)
    function onData(data) {
      const message = data.toString()
      if (message === 'pear:updateApplied') {
        clearTimeout(timer)
        pipe.removeListener('data', onData)
        resolve()
      }
    }
    pipe.on('data', onData)
    pipe.write('pear:applyUpdate')
  })
})

ipcMain.handle('pear:startWorker', (_evt, filename) => {
  getWorker(filename)
  return true
})

ipcMain.handle('app:afterUpdate', () => {
  if (isLinux && process.env.APPIMAGE) {
    app.relaunch({
      execPath: process.env.APPIMAGE,
      args: [
        '--appimage-extract-and-run',
        ...process.argv.slice(1).filter((arg) => arg !== '--appimage-extract-and-run'),
      ],
    })
  } else if (!isWindows) {
    app.relaunch()
  }
  app.quit()
})

function handleDeepLink(url) {
  console.log('deep link:', url)
  sendToAll('pear:deep-link', url)
}

app.setAsDefaultProtocolClient(protocol)

app.on('open-url', (evt, url) => {
  evt.preventDefault()
  handleDeepLink(url)
})

const lock = app.requestSingleInstanceLock()

if (!lock) {
  app.quit()
} else {
  app.on('second-instance', (_evt, args) => {
    const url = args.find((arg) => arg.startsWith(protocol + '://'))
    if (url) handleDeepLink(url)
    const wins = BrowserWindow.getAllWindows()
    if (wins[0]) {
      if (wins[0].isMinimized()) wins[0].restore()
      wins[0].focus()
    }
  })

  app.whenReady().then(() => {
    createWindow().catch((err) => {
      console.error('Failed to create window:', err)
      app.quit()
    })
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow().catch(console.error)
      }
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
