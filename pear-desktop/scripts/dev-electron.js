/**
 * Start parent Vite (React game) + Electron shell with Pear P2P worker.
 */
const { spawn } = require('child_process')
const path = require('path')
const http = require('http')

const root = path.resolve(__dirname, '../..')
const pear = path.resolve(__dirname, '..')
const port = process.env.PORT || '5173'
const host = '127.0.0.1'
const url = `http://${host}:${port}`

function waitForServer(timeoutMs = 60_000) {
  const start = Date.now()
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      const req = http.get(url, (res) => {
        res.resume()
        resolve()
      })
      req.on('error', () => {
        if (Date.now() - start > timeoutMs) {
          reject(new Error('Vite did not start in time at ' + url))
          return
        }
        setTimeout(tryOnce, 250)
      })
    }
    tryOnce()
  })
}

const vite = spawn(
  'pnpm',
  ['exec', 'vite', '--host', host, '--port', port, '--strictPort'],
  {
    cwd: root,
    stdio: 'inherit',
    shell: true,
    env: { ...process.env },
  },
)

let electronProc = null

function shutdown() {
  if (electronProc && !electronProc.killed) electronProc.kill()
  if (vite && !vite.killed) vite.kill()
  process.exit(0)
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

waitForServer()
  .then(() => {
    console.log('[dev-electron] Vite ready → launching Electron')
    electronProc = spawn(
      'npx',
      ['electron', '.', '--no-updates', '--dev'],
      {
        cwd: pear,
        stdio: 'inherit',
        shell: true,
        env: {
          ...process.env,
          PEAR_DEV_SERVER_URL: url,
        },
      },
    )
    electronProc.on('exit', (code) => {
      if (vite && !vite.killed) vite.kill()
      process.exit(code || 0)
    })
  })
  .catch((err) => {
    console.error(err)
    if (vite && !vite.killed) vite.kill()
    process.exit(1)
  })
