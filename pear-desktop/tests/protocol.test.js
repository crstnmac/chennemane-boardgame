const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const {
  PROTOCOL_VERSION,
  APP_ID,
  Msg,
  parseMessage,
  encodeMessage,
  isMoveIntent,
  isPassIntent,
  isResignIntent,
} = require('../workers/protocol')
const {
  generateRoomCode,
  normalizeRoomCode,
  topicFromRoomCode,
  topicHex,
} = require('../workers/room')

describe('protocol', () => {
  it('encodes version and app id', () => {
    const raw = encodeMessage({ type: Msg.PING, t: 1 })
    const data = JSON.parse(raw)
    assert.equal(data.v, PROTOCOL_VERSION)
    assert.equal(data.app, APP_ID)
    assert.equal(data.type, Msg.PING)
  })

  it('parses valid messages', () => {
    const line = encodeMessage({ type: Msg.MOVE, move: { startPit: 0, direction: 'ccw' } })
    const r = parseMessage(line)
    assert.equal(r.ok, true)
    assert.equal(r.msg.type, Msg.MOVE)
  })

  it('rejects bad json and missing type', () => {
    assert.equal(parseMessage('{').ok, false)
    assert.equal(parseMessage('{}').ok, false)
    assert.equal(parseMessage({ type: 1 }).ok, false)
  })

  it('rejects version mismatch', () => {
    const r = parseMessage(JSON.stringify({ v: 999, type: 'ping' }))
    assert.equal(r.ok, false)
    assert.equal(r.error, 'version_mismatch')
  })

  it('validates move/pass/resign intents', () => {
    assert.equal(
      isMoveIntent({ type: Msg.MOVE, move: { startPit: 3, direction: 'cw' } }),
      true,
    )
    assert.equal(isMoveIntent({ type: Msg.MOVE, move: { startPit: 3, direction: 'up' } }), false)
    assert.equal(isPassIntent({ type: Msg.PASS }), true)
    assert.equal(isResignIntent({ type: Msg.RESIGN }), true)
  })
})

describe('room', () => {
  it('generates codes of requested length from safe alphabet', () => {
    const code = generateRoomCode(6)
    assert.equal(code.length, 6)
    assert.match(code, /^[A-HJ-NP-Z2-9]+$/)
  })

  it('normalizes user input', () => {
    assert.equal(normalizeRoomCode(' ab-cd '), 'ABCD')
    assert.equal(normalizeRoomCode('k7m2qx'), 'K7M2QX')
  })

  it('derives stable 32-byte topics', () => {
    const a = topicFromRoomCode('K7M2QX')
    const b = topicFromRoomCode('k7m2qx')
    assert.equal(a.byteLength || a.length, 32)
    assert.deepEqual(Buffer.from(a), Buffer.from(b))
    assert.notDeepEqual(Buffer.from(a), Buffer.from(topicFromRoomCode('OTHER1')))
    assert.match(topicHex(a), /^[0-9a-f]{16}…$/)
  })

  it('rejects short room codes', () => {
    assert.throws(() => topicFromRoomCode('AB'), /room_code_too_short/)
  })
})
