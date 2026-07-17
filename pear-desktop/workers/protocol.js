/**
 * Wire protocol for Chennamane P2P multiplayer (JSON lines over Noise sockets).
 */
const PROTOCOL_VERSION = 1
const APP_ID = 'chennamane-pear-v1'

const Msg = {
  HELLO: 'hello',
  WELCOME: 'welcome',
  STATE: 'state',
  MOVE: 'move',
  PASS: 'pass',
  RESIGN: 'resign',
  REJECT: 'reject',
  CHAT: 'chat',
  PING: 'ping',
  PONG: 'pong',
  GOODBYE: 'goodbye',
  ERROR: 'error',
}

/** Faster liveness so a closed window is noticed (~8s worst case). */
const HEARTBEAT_INTERVAL_MS = 3000
const HEARTBEAT_TIMEOUT_MS = 9000

function parseMessage(raw) {
  let data
  try {
    data = typeof raw === 'string' ? JSON.parse(raw) : raw
  } catch {
    return { ok: false, error: 'invalid_json' }
  }
  if (!data || typeof data !== 'object' || typeof data.type !== 'string') {
    return { ok: false, error: 'missing_type' }
  }
  if (data.v != null && data.v !== PROTOCOL_VERSION) {
    return { ok: false, error: 'version_mismatch' }
  }
  return { ok: true, msg: data }
}

function encodeMessage(msg) {
  return JSON.stringify({ v: PROTOCOL_VERSION, app: APP_ID, ...msg })
}

function isMoveIntent(msg) {
  return (
    msg &&
    msg.type === Msg.MOVE &&
    msg.move &&
    typeof msg.move.startPit === 'number' &&
    (msg.move.direction === 'cw' || msg.move.direction === 'ccw')
  )
}

function isPassIntent(msg) {
  return msg && msg.type === Msg.PASS
}

function isResignIntent(msg) {
  return msg && msg.type === Msg.RESIGN
}

module.exports = {
  PROTOCOL_VERSION,
  APP_ID,
  Msg,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_TIMEOUT_MS,
  parseMessage,
  encodeMessage,
  isMoveIntent,
  isPassIntent,
  isResignIntent,
}
