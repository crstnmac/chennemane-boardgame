/**
 * Bare worker — full Pear product core:
 *  - pear-runtime OTA updates (hello-pear-worker shape) when upgrade link is set
 *  - Optional Corestore (only if OTA or match log enabled)
 *  - Hyperswarm P2P multiplayer session
 *
 * Memory: no Corestore/Hyperswarm OTA until needed; engine loaded on first match.
 */
const path = require('bare-path')
const bareStorage = require('bare-storage')
const goodbye = require('graceful-goodbye')
const FramedStream = require('framed-stream')
const { createP2PSession } = require('./session')

// Bare.argv layout differs on mobile BareKit vs desktop Bare worker
let isBareKit = false
try {
  isBareKit = require('which-runtime').isBareKit
} catch {
  isBareKit = false
}

function argv(index) {
  if (typeof Bare === 'undefined') {
    return process.argv[2 + index]
  }
  return Bare.argv[index + (isBareKit ? 0 : 2)]
}

const updaterConfig = {
  updates: argv(0) !== 'false',
  version: argv(1),
  upgrade: argv(2),
  name: argv(3),
  dir: argv(4),
  app: argv(5),
}

const pipe = typeof Bare !== 'undefined' && Bare.IPC ? new FramedStream(Bare.IPC) : null

function send(obj) {
  const line = typeof obj === 'string' ? obj : JSON.stringify(obj)
  if (pipe) {
    try {
      pipe.write(line)
    } catch (err) {
      console.error('[worker send]', err)
    }
  } else if (typeof process !== 'undefined' && process.stdout) {
    process.stdout.write(line + '\n')
  }
}

function sendEvt(name, data) {
  send({ type: 'evt', name, data: data || null })
}

function sendRes(id, ok, data, error) {
  send({ type: 'res', id, ok, data: data || null, error: error || null })
}

const storageRoot =
  updaterConfig.dir ||
  path.join(bareStorage.persistent(), 'chennamane-pear')

const MATCH_LOG_ENABLED =
  typeof process !== 'undefined' &&
  process.env &&
  process.env.CHENNAMANE_MATCH_LOG === '1'

let store = null
let swarm = null
let pear = null
let pearReady = false
let engine = null
let appStore = null
let session = null
let booted = false

function loadEngine() {
  if (engine) return engine
  try {
    engine = require('./lib/engine.js')
  } catch {
    engine = require('./lib/engine.cjs')
  }
  return engine
}

function upgradeLinkOk() {
  const upgradeRaw = String(updaterConfig.upgrade || '')
  return (
    updaterConfig.updates !== false &&
    upgradeRaw.length > 10 &&
    upgradeRaw.startsWith('pear://') &&
    !upgradeRaw.includes('<YOUR_KEY') &&
    !upgradeRaw.includes('PLACEHOLDER')
  )
}

/** Corestore is heavy — only open for OTA replication or opt-in match logs. */
async function ensureStore() {
  if (store) return store
  const Corestore = require('corestore')
  store = new Corestore(path.join(storageRoot, 'pear-runtime', 'corestore'))
  return store
}

async function initPear() {
  if (!upgradeLinkOk()) {
    pearReady = false
    sendEvt('ready', {
      storage: storageRoot,
      updates: false,
      version: updaterConfig.version,
      pearError: 'ota_disabled_no_upgrade_link',
    })
    return
  }

  try {
    // Lazy-require heavy modules only when OTA is actually configured
    const PearRuntime = require('pear-runtime')
    const Hyperswarm = require('hyperswarm')
    await ensureStore()
    if (!swarm) swarm = new Hyperswarm({ maxPeers: 4 })

    pear = new PearRuntime({
      ...updaterConfig,
      dir: storageRoot,
      swarm,
      store,
    })
    pear.updater.on('error', (err) => {
      console.error('[pear-updater]', err)
      sendEvt('updater_error', { message: err && err.message ? err.message : String(err) })
    })
    swarm.on('connection', (connection) => store.replicate(connection))
    swarm.join(pear.updater.drive.core.discoveryKey, {
      client: true,
      server: false,
    })
    pear.updater.on('updating', () => {
      send('updating')
      sendEvt('updating')
    })
    pear.updater.on('updated', () => {
      send('updated')
      sendEvt('updated')
    })
    console.log('Application storage:', pear.storage || storageRoot)
    pearReady = true
    sendEvt('ready', {
      storage: pear.storage || storageRoot,
      updates: true,
      version: updaterConfig.version,
    })
  } catch (err) {
    console.error('[pear-runtime init]', err)
    pearReady = false
    sendEvt('ready', {
      storage: storageRoot,
      updates: false,
      version: updaterConfig.version,
      pearError: err && err.message ? err.message : String(err),
    })
  }
}

function bindSession(s) {
  s.on('status', (st) => sendEvt('status', st))
  s.on('match_ready', (m) => sendEvt('match_ready', m))
  s.on('welcomed', (m) => sendEvt('welcomed', m))
  s.on('peer_hello', (m) => sendEvt('peer_hello', m))
  s.on('peer_reconnected', (m) => sendEvt('peer_reconnected', m))
  s.on('reconnecting', (m) => sendEvt('reconnecting', m))
  s.on('peer_disconnected', (m) => sendEvt('peer_disconnected', m))
  s.on('peer_connected', (m) => sendEvt('peer_connected', m))
  s.on('game', (g) => {
    if (!g) return
    const base = {
      state: g.state,
      seq: g.seq,
      localSide: g.localSide,
      role: g.role,
      roomCode: g.roomCode || null,
      connected: Boolean(g.connected),
      terminal: g.terminal,
      winner: g.winner,
      yourTurn: g.yourTurn,
      reason: g.reason || null,
      localPlayerName: g.localPlayerName || null,
      remotePlayerName: g.remotePlayerName || null,
    }
    if (Array.isArray(g.events) && g.events.length > 200) {
      sendEvt('game', {
        ...base,
        legal: [],
        events: [],
        reason: g.reason === 'welcome' ? g.reason : 'snapshot',
      })
      return
    }
    sendEvt('game', {
      ...base,
      legal: g.legal || [],
      events: g.events || [],
    })
  })
  s.on('error', (err) =>
    sendEvt('error', { message: err && err.message ? err.message : String(err) }),
  )
  s.on('reject', (r) => sendEvt('reject', r))
  s.on('chat', (c) => sendEvt('chat', c))
}

async function ensureSession() {
  if (session && typeof session.isDestroyed === 'function' && session.isDestroyed()) {
    session = null
  }
  if (session) return session

  const eng = loadEngine()
  // Match log only: open Corestore when explicitly enabled
  if (MATCH_LOG_ENABLED && !appStore) {
    await ensureStore()
    try {
      appStore = typeof store.namespace === 'function' ? store.namespace('chennamane-game') : store
    } catch {
      appStore = store
    }
  }

  session = createP2PSession(eng, { store: appStore })
  bindSession(session)
  return session
}

async function handleCommand(msg) {
  const id = msg.id
  const op = msg.op
  try {
    if (!booted) {
      await boot()
    }
    if (op === 'info') {
      sendRes(id, true, {
        storage: (pear && pear.storage) || storageRoot,
        pearReady,
        version: updaterConfig.version,
        product: 'Chennamane Pear',
        stack: 'pear-runtime + Bare worker + Hyperswarm',
        matchLog: MATCH_LOG_ENABLED,
      })
      return
    }
    if (op === 'host') {
      if (session && typeof session.isDestroyed === 'function' && session.isDestroyed()) {
        session = null
      }
      const s = await ensureSession()
      const data = await s.hostGame(msg.payload || {})
      sendRes(id, true, data)
      return
    }
    if (op === 'join') {
      if (session && typeof session.isDestroyed === 'function' && session.isDestroyed()) {
        session = null
      }
      const s = await ensureSession()
      const payload = msg.payload || {}
      const data = await s.joinGame({
        code: payload.code || payload,
        playerName: payload.playerName,
      })
      sendRes(id, true, data)
      return
    }
    if (op === 'reconnect') {
      if (!session || (typeof session.isDestroyed === 'function' && session.isDestroyed())) {
        sendRes(id, false, null, 'no_session')
        return
      }
      const data = await session.reconnectGame()
      sendRes(id, true, data)
      return
    }
    if (op === 'play') {
      const s = await ensureSession()
      const data = s.play(msg.payload || {})
      sendRes(id, data.ok !== false, data, data.ok === false ? data.error : null)
      return
    }
    if (op === 'chat') {
      const s = await ensureSession()
      const data = s.sendChat(msg.payload && msg.payload.text)
      sendRes(id, data.ok !== false, data, data.ok === false ? data.error : null)
      return
    }
    if (op === 'snapshot') {
      const s = await ensureSession()
      sendRes(id, true, s.getSnapshot())
      return
    }
    if (op === 'destroy') {
      if (session) {
        await session.destroy()
        session = null
      }
      sendRes(id, true, { destroyed: true })
      return
    }
    sendRes(id, false, null, 'unknown_op')
  } catch (err) {
    console.error('[handleCommand]', op, err)
    sendRes(id, false, null, err && err.message ? err.message : String(err))
  }
}

async function onPipeData(data) {
  const message = data.toString()

  if (message === 'pear:applyUpdate') {
    try {
      if (pear) {
        await pear.ready()
        await pear.updater.applyUpdate()
      }
      send('pear:updateApplied')
    } catch (err) {
      console.error(err)
      sendEvt('error', { message: err && err.message ? err.message : String(err) })
      send('pear:updateApplied')
    }
    return
  }

  let msg
  try {
    msg = JSON.parse(message)
  } catch {
    console.log('[worker raw]', message)
    return
  }

  if (msg.type === 'cmd') {
    await handleCommand(msg)
  }
}

if (pipe) {
  pipe.on('data', (data) => {
    onPipeData(data).catch((err) => console.error(err))
  })
}

goodbye(async () => {
  try {
    if (session) await session.destroy()
  } catch {
    /* ignore */
  }
  try {
    if (swarm) await swarm.destroy()
  } catch {
    /* ignore */
  }
  try {
    if (pear) await pear.close()
  } catch {
    /* ignore */
  }
  try {
    if (store) await store.close()
  } catch {
    /* ignore */
  }
})

let bootPromise = null
async function boot() {
  if (booted) return
  if (bootPromise) return bootPromise
  bootPromise = (async () => {
    // Do not load engine or Corestore until a match starts (ensureSession)
    await initPear()
    booted = true
    sendEvt('worker_hello', { ok: true })
  })().catch((err) => {
    console.error('[boot]', err)
    booted = true
    sendEvt('worker_hello', { ok: false, error: String(err && err.message ? err.message : err) })
    sendEvt('ready', {
      storage: storageRoot,
      updates: false,
      version: updaterConfig.version,
      pearError: String(err && err.message ? err.message : err),
    })
  })
  return bootPromise
}

boot().catch((err) => console.error(err))
