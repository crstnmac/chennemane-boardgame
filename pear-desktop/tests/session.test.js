const { describe, it, before } = require('node:test')
const assert = require('node:assert/strict')
const path = require('path')
const { createP2PSession } = require('../workers/session')
const { Msg, encodeMessage, parseMessage } = require('../workers/protocol')
const { generateRoomCode, topicFromRoomCode } = require('../workers/room')

let engine

before(() => {
  engine = require(path.join(__dirname, '../workers/lib/engine.cjs'))
})

describe('session host authority (local engine)', () => {
  it('host can create game and play a legal South move', async () => {
    const session = createP2PSession(engine)
    const game = engine.createGame(
      { directionMode: 'bidirectional', initialSeedsPerPit: 5 },
      { firstPlayer: 'S' },
    )
    const legal = engine.getLegalMoves(game)
    assert.ok(legal.length > 0)
    const { state } = engine.applyMove(game, legal[0])
    assert.ok(state.pits)
    assert.notEqual(JSON.stringify(state.pits), JSON.stringify(game.pits))
    await session.destroy()
  })

  it('applyPass rejects when legal moves exist', () => {
    const game = engine.createGame({}, { firstPlayer: 'S' })
    assert.throws(() => engine.applyPass(game))
  })

  it('resign marks terminal', () => {
    const game = engine.createGame({}, { firstPlayer: 'S' })
    const { state } = engine.resign(game, 'S')
    assert.equal(engine.isTerminal(state), true)
    assert.equal(state.resigned, 'S')
  })

  it('exposes session API surface', () => {
    const session = createP2PSession(engine)
    assert.equal(typeof session.hostGame, 'function')
    assert.equal(typeof session.joinGame, 'function')
    assert.equal(typeof session.play, 'function')
    assert.equal(typeof session.sendChat, 'function')
    assert.equal(typeof session.getSnapshot, 'function')
    assert.equal(typeof session.destroy, 'function')
  })
})

describe('room codes for swarm topics', () => {
  it('unique codes produce distinct topics', () => {
    const set = new Set()
    for (let i = 0; i < 20; i++) {
      set.add(Buffer.from(topicFromRoomCode(generateRoomCode(6))).toString('hex'))
    }
    assert.equal(set.size, 20)
  })
})

describe('protocol round-trip for STATE payload', () => {
  it('serializes a full game state', () => {
    const game = engine.createGame({}, { firstPlayer: 'S' })
    const line = encodeMessage({ type: Msg.STATE, seq: 1, state: engine.cloneState(game) })
    const parsed = parseMessage(line)
    assert.equal(parsed.ok, true)
    assert.equal(parsed.msg.type, Msg.STATE)
    assert.equal(parsed.msg.state.pits.length, 14)
    assert.equal(parsed.msg.state.toMove, 'S')
  })
})

describe('json-line framing', () => {
  it('parseMessage accepts encodeMessage with newline stripped', () => {
    const framed = encodeMessage({ type: Msg.HELLO, role: 'guest' }) + '\n'
    const r = parseMessage(framed.trim())
    assert.equal(r.ok, true)
    assert.equal(r.msg.type, Msg.HELLO)
  })
})
