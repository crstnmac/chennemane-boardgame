/**
 * P2P multiplayer session using Hyperswarm (Holepunch / pears.com).
 * Host is game authority; guest sends intents; host broadcasts STATE.
 *
 * Memory notes:
 *  - Match log stores compact deltas (not full boards) and is capped.
 *  - Wire STATE omits recomputable `legal` (receivers derive from engine).
 *  - Socket read buffer is bounded.
 *  - State is serialized once per broadcast.
 */
const Hyperswarm = require('hyperswarm')
const hypercoreCrypto = require('hypercore-crypto')
const b4a = require('b4a')
const {
  Msg,
  PROTOCOL_VERSION,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_TIMEOUT_MS,
  encodeMessage,
  parseMessage,
  isMoveIntent,
  isPassIntent,
  isResignIntent,
} = require('./protocol')
const { generateRoomCode, normalizeRoomCode, topicFromRoomCode, topicHex } = require('./room')

const MAX_SOCKET_BUF = 256 * 1024
const MAX_MATCH_LOG_ENTRIES = 64
/** Long sowing chains can produce thousands of events — cap wire/UI payload. */
const MAX_WIRE_EVENTS = 200
/** Match logging is opt-in (Corestore growth). CHENNAMANE_MATCH_LOG=1 enables compact logs. */
const MATCH_LOG_ENABLED =
  typeof process !== 'undefined' &&
  process.env &&
  process.env.CHENNAMANE_MATCH_LOG === '1'
/** Full-board log entries only when explicitly requested. */
const MATCH_LOG_FULL =
  typeof process !== 'undefined' &&
  process.env &&
  process.env.CHENNAMANE_MATCH_LOG_FULL === '1'

function isValidGameState(state) {
  if (
    !state ||
    typeof state !== 'object' ||
    !Array.isArray(state.pits) ||
    state.pits.length !== 14 ||
    !state.score ||
    typeof state.score.S !== 'number' ||
    typeof state.score.N !== 'number' ||
    (state.toMove !== 'S' && state.toMove !== 'N')
  ) {
    return false
  }
  for (let i = 0; i < 14; i++) {
    const n = state.pits[i]
    if (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > 500) {
      return false
    }
  }
  // Optional fields: reject huge protectedMask / events smuggled in state
  if (state.protectedMask && (!Array.isArray(state.protectedMask) || state.protectedMask.length !== 14)) {
    return false
  }
  return true
}

function capEvents(events) {
  if (!events || !events.length) return []
  if (events.length <= MAX_WIRE_EVENTS) return events
  return []
}

/** Minimal event bus (Bare-portable). */
function createBus() {
  const map = new Map()
  return {
    on(name, fn) {
      if (!map.has(name)) map.set(name, new Set())
      map.get(name).add(fn)
      return this
    },
    off(name, fn) {
      const set = map.get(name)
      if (set) set.delete(fn)
      return this
    },
    once(name, fn) {
      const wrap = (data) => {
        this.off(name, wrap)
        fn(data)
      }
      return this.on(name, wrap)
    },
    emit(name, data) {
      const set = map.get(name)
      if (!set) return
      for (const fn of set) {
        try {
          fn(data)
        } catch (err) {
          console.error(err)
        }
      }
    },
    removeAllListeners() {
      map.clear()
    },
  }
}

/**
 * @param {object} engine bundled engine module (CJS)
 * @param {object} [opts]
 * @param {object|null} [opts.store] Corestore namespace
 */
function createP2PSession(engine, opts) {
  opts = opts || {}
  const store = opts.store || null

  const {
    createGame,
    applyMove,
    applyPass,
    resign: engineResign,
    getLegalMoves,
    isTerminal,
    getWinner,
    cloneState,
  } = engine

  const bus = createBus()
  let swarm = null
  let peerSocket = null
  let discovery = null
  let currentTopic = null
  let role = null
  let localSide = null
  let roomCode = null
  let game = null
  let seq = 0
  let connected = false
  let destroyed = false
  let buf = ''
  let pingTimer = null
  let matchCore = null
  let matchLogCount = 0
  let localPlayerName = 'Player'
  let remotePlayerName = null
  /** True after first successful HELLO — later HELLOs are reconnects. */
  let matchEverStarted = false
  /** Guest: force next STATE apply (same seq after reconnect). */
  let forceNextState = false
  /** Last time we received any data / PONG from peer. */
  let lastPeerAliveAt = 0

  function sanitizeName(n) {
    const t = String(n || '')
      .trim()
      .replace(/\s+/g, ' ')
      .slice(0, 24)
    return t || 'Player'
  }
  /** @type {ReturnType<typeof setTimeout>|null} */
  let logFlushTimer = null
  /** @type {ReturnType<typeof setTimeout>|null} */
  let swarmStatusTimer = null
  let lastEmittedPeers = -1

  function clearPing() {
    if (pingTimer) {
      clearInterval(pingTimer)
      pingTimer = null
    }
  }

  function startPing() {
    clearPing()
    lastPeerAliveAt = Date.now()
    pingTimer = setInterval(() => {
      if (!peerSocket || !connected) {
        clearPing()
        return
      }
      write({ type: Msg.PING, t: Date.now() })
      if (Date.now() - lastPeerAliveAt > HEARTBEAT_TIMEOUT_MS) {
        try {
          peerSocket.destroy()
        } catch {
          /* ignore */
        }
        peerSocket = null
        connected = false
        clearPing()
        buf = ''
        emit('peer_disconnected', {
          remotePlayerName,
          roomCode,
          role,
          localSide,
          reason: 'heartbeat_timeout',
        })
      }
    }, HEARTBEAT_INTERVAL_MS)
  }

  function emit(status, extra) {
    // Skip no-op swarm_update spam (DHT churn) unless peer count changed
    if (status === 'swarm_update') {
      const peers = swarm && swarm.connections ? swarm.connections.size : 0
      if (peers === lastEmittedPeers) return
      lastEmittedPeers = peers
    } else if (status === 'peer_connected' || status === 'peer_disconnected' || status === 'peer_reconnected') {
      lastEmittedPeers = swarm && swarm.connections ? swarm.connections.size : 0
    }
    const payload = {
      status,
      role,
      localSide,
      roomCode,
      connected,
      localPlayerName,
      remotePlayerName,
      peers: swarm && swarm.connections ? swarm.connections.size : 0,
      topicPreview: currentTopic ? topicHex(currentTopic) : null,
      ...(extra || {}),
    }
    // Always mirror as status (store watches status.status)
    bus.emit('status', payload)
    // Named events for bridge (match_ready / welcomed / peer_reconnected / …)
    if (
      status === 'match_ready' ||
      status === 'welcomed' ||
      status === 'peer_hello' ||
      status === 'peer_reconnected' ||
      status === 'reconnecting' ||
      status === 'peer_disconnected' ||
      status === 'peer_connected' ||
      status === 'channel_open'
    ) {
      bus.emit(status, payload)
    }
  }

  /** Config fields the peer needs to recompute legal moves (omit display fluff). */
  function slimConfig(config) {
    if (!config) return config
    return {
      id: config.id,
      engineFamily: config.engineFamily,
      rows: config.rows,
      pitsPerRow: config.pitsPerRow,
      storesInCircuit: config.storesInCircuit,
      pitCount: config.pitCount,
      seedFill: config.seedFill,
      initialSeedsPerPit: config.initialSeedsPerPit,
      directionMode: config.directionMode,
      secondSowing: config.secondSowing,
      capture: config.capture,
      emptySide: config.emptySide,
      relay: config.relay,
      matchStructure: config.matchStructure,
      residual: config.residual,
      playerCount: config.playerCount,
      bestOf: config.bestOf,
      // Omit displayName, customLayout when unused — smaller wire + IPC
      ...(config.customLayout && config.customLayout.length
        ? { customLayout: config.customLayout.slice() }
        : {}),
    }
  }

  function serializeState(state) {
    // Prefer engine clone then slim config (clone is correct; config is largest leaf)
    if (cloneState) {
      const c = cloneState(state)
      c.config = slimConfig(c.config)
      return c
    }
    return {
      pits: state.pits.slice(),
      score: { S: state.score.S, N: state.score.N, E: state.score.E ?? 0 },
      toMove: state.toMove,
      sowingsUsedThisTurn: state.sowingsUsedThisTurn,
      protectedMask: state.protectedMask ? state.protectedMask.slice() : [],
      config: slimConfig(state.config),
      resigned: state.resigned,
      initialTotal: state.initialTotal,
      quietTurns: state.quietTurns,
      openingComplete: state.openingComplete,
      roundIndex: state.roundIndex,
      bank: state.bank ? { S: state.bank.S || 0, N: state.bank.N || 0, E: state.bank.E || 0 } : { S: 0, N: 0, E: 0 },
      seriesOver: state.seriesOver,
    }
  }

  /**
   * Snapshot for UI. Skip `legal` by default — React recomputes via getLegalMoves
   * and this avoids allocating move arrays on every STATE broadcast.
   */
  function buildGamePayload(reason, events, serialized, opts) {
    const state = serialized || (game ? serializeState(game) : null)
    const includeLegal = opts && opts.includeLegal
    const terminal = game ? isTerminal(game) : false
    return {
      state,
      seq,
      localSide,
      role,
      roomCode,
      connected,
      terminal,
      winner: terminal && game ? getWinner(game) : null,
      legal: includeLegal && game && !terminal ? getLegalMoves(game) : [],
      yourTurn: Boolean(
        game && localSide && game.toMove === localSide && !terminal && connected,
      ),
      // Prefer [] over null so JSON stays smaller / uniform
      events: events && events.length ? events : [],
      reason: reason || null,
      localPlayerName,
      remotePlayerName,
    }
  }

  function emitGameWith(reason, events, serialized) {
    bus.emit('game', buildGamePayload(reason, events, serialized))
  }

  async function appendMatchLog(reason) {
    if (!MATCH_LOG_ENABLED || !matchCore || !game) return
    if (matchLogCount >= MAX_MATCH_LOG_ENTRIES) return
    try {
      const entry = MATCH_LOG_FULL
        ? {
            t: Date.now(),
            seq,
            reason,
            roomCode,
            state: serializeState(game),
          }
        : {
            t: Date.now(),
            seq,
            reason,
            score: { S: game.score.S, N: game.score.N },
            toMove: game.toMove,
            terminal: isTerminal(game),
          }
      await matchCore.append(b4a.from(JSON.stringify(entry)))
      matchLogCount += 1
    } catch (err) {
      bus.emit('error', err)
    }
  }

  async function openMatchLog(code) {
    if (!MATCH_LOG_ENABLED || !store) return
    try {
      matchCore = store.get({ name: 'match:' + normalizeRoomCode(code) })
      await matchCore.ready()
      matchLogCount = 0
    } catch (err) {
      bus.emit('error', err)
      matchCore = null
    }
  }

  async function closeMatchLog() {
    if (logFlushTimer) {
      clearTimeout(logFlushTimer)
      logFlushTimer = null
    }
    if (matchCore) {
      try {
        if (typeof matchCore.close === 'function') await matchCore.close()
      } catch {
        /* ignore */
      }
    }
    matchCore = null
    matchLogCount = 0
  }

  function write(msg) {
    if (!peerSocket || peerSocket.destroyed) return false
    try {
      peerSocket.write(encodeMessage(msg) + '\n')
      return true
    } catch (err) {
      bus.emit('error', err)
      return false
    }
  }

  function broadcastState(reason, events) {
    if (!game) return
    // Serialize once — reuse for wire + local emit
    const serialized = serializeState(game)
    const ev = capEvents(events)
    const reasonOut =
      ev.length === 0 && events && events.length > MAX_WIRE_EVENTS
        ? 'snapshot'
        : reason || 'update'
    // Wire: omit legal (guest recomputes) to cut payload size
    const hostName = role === 'host' ? localPlayerName : remotePlayerName
    const guestName = role === 'host' ? remotePlayerName : localPlayerName
    write({
      type: Msg.STATE,
      seq,
      reason: reasonOut,
      state: serialized,
      events: ev,
      hostName,
      guestName,
    })
    emitGameWith(reasonOut, ev, serialized)
    if (MATCH_LOG_ENABLED && matchCore) {
      if (logFlushTimer) clearTimeout(logFlushTimer)
      logFlushTimer = setTimeout(() => {
        logFlushTimer = null
        appendMatchLog(reason || 'update')
      }, 0)
    }
  }

  function attachSocket(socket, as) {
    // Prefer the newest socket (stale sockets may never emit close)
    if (peerSocket && peerSocket !== socket) {
      try {
        peerSocket.destroy()
      } catch {
        /* ignore */
      }
      peerSocket = null
      connected = false
      clearPing()
      buf = ''
    }
    peerSocket = socket
    // Guest is match-connected on socket open; host waits for HELLO
    connected = role === 'guest'
    buf = ''
    lastPeerAliveAt = Date.now()
    emit(role === 'guest' ? 'peer_connected' : 'channel_open', { as, connected })
    startPing()

    if (typeof socket.setEncoding === 'function') {
      socket.setEncoding('utf8')
    }

    socket.on('data', (chunk) => {
      lastPeerAliveAt = Date.now()
      const text = typeof chunk === 'string' ? chunk : b4a.toString(chunk)
      if (buf.length + text.length > MAX_SOCKET_BUF) {
        bus.emit('error', new Error('socket_buffer_overflow'))
        try {
          socket.destroy()
        } catch {
          /* ignore */
        }
        return
      }
      buf += text
      let idx
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim()
        buf = buf.slice(idx + 1)
        if (!line) continue
        handleLine(line)
      }
    })
    socket.on('close', () => {
      if (peerSocket === socket) {
        clearPing()
        peerSocket = null
        connected = false
        // Keep remotePlayerName so UI can show "waiting for X" during reconnect
        buf = ''
        emit('peer_disconnected', {
          remotePlayerName,
          roomCode,
          role,
          localSide,
        })
        // Guest: re-announce on the topic so a host still waiting can re-link
        if (role === 'guest' && !destroyed && roomCode) {
          setTimeout(() => {
            if (destroyed || connected || peerSocket) return
            reconnectGame().catch((err) => {
              bus.emit('error', err)
            })
          }, 1200)
        }
      }
    })
    socket.on('error', (err) => {
      bus.emit('error', err)
      try {
        socket.destroy()
      } catch {
        /* ignore */
      }
    })

    if (role === 'host') {
      // Wait for guest HELLO (with name) before WELCOME + first STATE —
      // match must not begin until a peer has joined.
    } else {
      const isReconnect = matchEverStarted || Boolean(game && seq > 0)
      if (isReconnect) forceNextState = true
      write({
        type: Msg.HELLO,
        role: 'guest',
        side: 'N',
        protocol: PROTOCOL_VERSION,
        playerName: localPlayerName,
        reconnect: isReconnect,
        lastSeq: seq,
      })
    }
  }

  function handleLine(line) {
    const parsed = parseMessage(line)
    if (!parsed.ok) {
      write({ type: Msg.REJECT, reason: parsed.error })
      return
    }
    const msg = parsed.msg

    if (msg.type === Msg.PING) {
      lastPeerAliveAt = Date.now()
      write({ type: Msg.PONG, t: msg.t })
      return
    }
    if (msg.type === Msg.PONG) {
      lastPeerAliveAt = Date.now()
      return
    }

    if (msg.type === Msg.HELLO && role === 'host') {
      // Only one active guest socket; extra sockets are closed in swarm handler.
      // After a drop, peerSocket is cleared so a reconnect HELLO is accepted.
      remotePlayerName = sanitizeName(msg.playerName)
      const isReconnect = matchEverStarted || Boolean(msg.reconnect)
      matchEverStarted = true
      // Host is match-connected only after HELLO
      connected = true
      emit('peer_hello', { playerName: remotePlayerName, reconnect: isReconnect })
      write({
        type: Msg.WELCOME,
        role: 'guest',
        side: 'N',
        roomCode,
        hostSide: 'S',
        hostName: localPlayerName,
        guestName: remotePlayerName,
        reconnect: isReconnect,
      })
      if (!game) {
        game = createGame(
          { directionMode: 'bidirectional', initialSeedsPerPit: 5 },
          { firstPlayer: 'S' },
        )
        seq = 1
      }
      // Resync full board on reconnect; first join uses welcome
      broadcastState(isReconnect ? 'reconnect' : 'welcome', [])
      emit('match_ready', {
        localPlayerName,
        remotePlayerName,
        roomCode,
        role,
        localSide,
        hostName: localPlayerName,
        guestName: remotePlayerName,
        reconnect: isReconnect,
      })
      if (isReconnect) {
        emit('peer_reconnected', {
          localPlayerName,
          remotePlayerName,
          roomCode,
        })
      }
      return
    }

    if (msg.type === Msg.WELCOME && role === 'guest') {
      localSide = msg.side === 'S' ? 'S' : 'N'
      roomCode = msg.roomCode || roomCode
      remotePlayerName = sanitizeName(msg.hostName)
      if (msg.guestName) {
        const gName = sanitizeName(msg.guestName)
        if (
          gName &&
          gName !== 'Player' &&
          (!localPlayerName || localPlayerName === 'Player')
        ) {
          localPlayerName = gName
        }
      }
      if (msg.reconnect || matchEverStarted) forceNextState = true
      matchEverStarted = true
      emit('welcomed', {
        side: localSide,
        hostName: remotePlayerName,
        guestName: localPlayerName,
        localPlayerName,
        remotePlayerName,
        roomCode,
        role,
        localSide,
        reconnect: Boolean(msg.reconnect),
      })
      if (msg.reconnect) {
        emit('peer_reconnected', {
          localPlayerName,
          remotePlayerName,
          roomCode,
        })
      }
      return
    }

    if (msg.type === Msg.CHAT) {
      bus.emit('chat', {
        from: role === 'host' ? 'guest' : 'host',
        text: String(msg.text || '').slice(0, 280),
      })
      return
    }

    if (msg.type === Msg.GOODBYE) {
      // Remote is leaving intentionally (tab/app close)
      try {
        if (peerSocket) peerSocket.destroy()
      } catch {
        /* ignore */
      }
      peerSocket = null
      connected = false
      clearPing()
      buf = ''
      emit('peer_disconnected', {
        remotePlayerName,
        roomCode,
        role,
        localSide,
        reason: 'goodbye',
      })
      emit('peer_goodbye')
      return
    }

    if (msg.type === Msg.STATE) {
      if (role === 'guest' && msg.state) {
        if (!isValidGameState(msg.state)) {
          bus.emit('error', new Error('invalid_state_payload'))
          return
        }
        const incomingSeq = msg.seq != null ? msg.seq : seq
        const reasonHint = msg.reason || 'state'
        const force =
          forceNextState || reasonHint === 'reconnect' || reasonHint === 'welcome'
        // Ignore stale / replayed snapshots unless reconnect resync
        if (incomingSeq < seq && !force) return
        if (incomingSeq === seq && game && !force) return
        forceNextState = false
        game = msg.state
        seq = incomingSeq
        if (msg.hostName) remotePlayerName = sanitizeName(msg.hostName)
        // Do not clobber a real guest nickname with a default echo
        if (msg.guestName) {
          const gName = sanitizeName(msg.guestName)
          if (
            gName &&
            gName !== 'Player' &&
            (!localPlayerName || localPlayerName === 'Player')
          ) {
            localPlayerName = gName
          }
        }
        // Drop non-array / huge event payloads before UI
        const rawEvents = Array.isArray(msg.events) ? msg.events : []
        const ev = force ? [] : capEvents(rawEvents)
        const reason = force
          ? reasonHint === 'welcome'
            ? 'welcome'
            : reasonHint === 'reconnect'
              ? 'reconnect'
              : reasonHint
          : ev.length === 0 && rawEvents.length > MAX_WIRE_EVENTS
            ? 'snapshot'
            : reasonHint
        // Guest: use wire state as-is (already a plain object); do not re-clone
        emitGameWith(reason, ev, msg.state)
      }
      return
    }

    if (msg.type === Msg.REJECT) {
      bus.emit('reject', msg)
      return
    }

    if (role === 'host') {
      handleHostIntent(msg)
    }
  }

  function handleHostIntent(msg) {
    if (!game || isTerminal(game)) {
      write({ type: Msg.REJECT, reason: 'game_over' })
      return
    }

    try {
      if (isResignIntent(msg)) {
        const result = engineResign(game, 'N')
        game = result.state
        seq += 1
        broadcastState('resign', result.events)
        return
      }

      if (game.toMove !== 'N') {
        write({ type: Msg.REJECT, reason: 'not_your_turn' })
        return
      }

      if (isMoveIntent(msg)) {
        // Validate pit is integer in range
        const pit = msg.move.startPit
        if (!Number.isInteger(pit) || pit < 0 || pit > 13) {
          write({ type: Msg.REJECT, reason: 'illegal', detail: 'bad_pit' })
          return
        }
        const result = applyMove(game, msg.move)
        game = result.state
        seq += 1
        broadcastState('move', result.events)
        return
      }
      if (isPassIntent(msg)) {
        const result = applyPass(game)
        game = result.state
        seq += 1
        broadcastState('pass', result.events)
        return
      }
      write({ type: Msg.REJECT, reason: 'unknown_intent' })
    } catch (err) {
      write({
        type: Msg.REJECT,
        reason: 'illegal',
        detail: err && err.message ? err.message : String(err),
      })
    }
  }

  async function ensureSwarm() {
    if (swarm) return swarm
    swarm = new Hyperswarm({
      seed: hypercoreCrypto.randomBytes(32),
      maxPeers: 2, // 1v1 only
    })
    swarm.on('connection', (socket, info) => {
      if (destroyed) {
        socket.destroy()
        return
      }
      // Prefer newest socket — stale peerSocket often never emits close
      if (peerSocket && peerSocket !== socket) {
        try {
          peerSocket.destroy()
        } catch {
          /* ignore */
        }
        peerSocket = null
        connected = false
        clearPing()
        buf = ''
      }
      attachSocket(socket, info && info.client ? 'client' : 'server')
    })
    // Throttle DHT churn: at most one status every 2s, and only if peers changed
    swarm.on('update', () => {
      if (swarmStatusTimer) return
      swarmStatusTimer = setTimeout(() => {
        swarmStatusTimer = null
        if (!destroyed) emit('swarm_update')
      }, 2000)
    })
    return swarm
  }

  async function hostGame(options) {
    options = options || {}
    if (destroyed) {
      throw new Error('session_destroyed')
    }
    await destroyNetworking()
    destroyed = false
    role = 'host'
    localSide = 'S'
    localPlayerName = sanitizeName(options.playerName)
    remotePlayerName = null
    matchEverStarted = false
    roomCode = generateRoomCode(6)
    // Prepare game state but do not broadcast until a peer joins (HELLO)
    game = createGame(
      {
        directionMode: options.directionMode || 'bidirectional',
        initialSeedsPerPit: options.seeds || 5,
        matchStructure: options.multiRound ? 'multi-round-protected' : 'single',
        residual: options.residual || 'unclaimed',
      },
      { firstPlayer: options.firstPlayer || 'S' },
    )
    seq = 1
    await openMatchLog(roomCode)
    void appendMatchLog('host_create')

    const s = await ensureSwarm()
    currentTopic = topicFromRoomCode(roomCode)
    discovery = s.join(currentTopic, { server: true, client: true })
    Promise.resolve(discovery.flushed?.())
      .then(() => emit('discovery_ready', { roomCode }))
      .catch((err) => bus.emit('error', err))
    emit('hosting', { roomCode, localPlayerName })
    // Do not emitGame / broadcast — match starts only after peer joins
    return {
      roomCode,
      topic: topicHex(currentTopic),
      localPlayerName,
    }
  }

  async function joinGame(options) {
    if (destroyed) {
      throw new Error('session_destroyed')
    }
    const opts = typeof options === 'string' ? { code: options } : options || {}
    await destroyNetworking()
    destroyed = false
    role = 'guest'
    localSide = 'N'
    localPlayerName = sanitizeName(opts.playerName)
    remotePlayerName = null
    matchEverStarted = false
    roomCode = normalizeRoomCode(opts.code)
    if (roomCode.length < 4) {
      throw new Error('room_code_too_short')
    }
    game = null
    seq = 0
    await openMatchLog(roomCode)

    const s = await ensureSwarm()
    currentTopic = topicFromRoomCode(roomCode)
    discovery = s.join(currentTopic, { server: true, client: true })
    Promise.resolve(discovery.flushed?.())
      .then(() => emit('discovery_ready', { roomCode }))
      .catch((err) => bus.emit('error', err))
    emit('joining', { roomCode, localPlayerName })
    return {
      roomCode,
      topic: topicHex(currentTopic),
      localPlayerName,
    }
  }

  function play(action) {
    if (destroyed) return { ok: false, error: 'destroyed' }
    if (!game || !localSide) {
      return { ok: false, error: 'no_game' }
    }
    // No solo play — require a connected peer before any move
    if (!connected) {
      return { ok: false, error: 'waiting_for_peer' }
    }
    if (isTerminal(game)) {
      return { ok: false, error: 'game_over' }
    }

    if (action.type === 'resign') {
      if (role === 'guest') {
        if (!connected) return { ok: false, error: 'not_connected' }
        write({ type: Msg.RESIGN })
        return { ok: true, pending: true }
      }
      try {
        const result = engineResign(game, localSide)
        game = result.state
        seq += 1
        // Always broadcastState so hostName/guestName ride every STATE
        const ev = capEvents(result.events)
        const reasonOut = ev.length ? 'resign' : 'snapshot'
        broadcastState(reasonOut, result.events)
        return {
          ok: true,
          seq,
          state: serializeState(game),
          events: ev,
        }
      } catch (err) {
        return { ok: false, error: 'illegal', detail: err && err.message }
      }
    }

    if (game.toMove !== localSide) {
      return { ok: false, error: 'not_your_turn' }
    }

    if (role === 'guest') {
      if (!connected) return { ok: false, error: 'not_connected' }
      if (action.type === 'move' && action.move) {
        write({ type: Msg.MOVE, move: action.move })
        return { ok: true, pending: true }
      }
      if (action.type === 'pass') {
        write({ type: Msg.PASS })
        return { ok: true, pending: true }
      }
      return { ok: false, error: 'bad_action' }
    }

    try {
      if (action.type === 'move' && action.move) {
        const result = applyMove(game, action.move)
        game = result.state
        seq += 1
        const ev = capEvents(result.events)
        const reasonOut =
          ev.length ? 'move' : result.events && result.events.length ? 'snapshot' : 'move'
        broadcastState(reasonOut, result.events)
        return {
          ok: true,
          seq,
          state: serializeState(game),
          events: ev,
        }
      }
      if (action.type === 'pass') {
        const result = applyPass(game)
        game = result.state
        seq += 1
        const ev = capEvents(result.events)
        broadcastState('pass', result.events)
        return {
          ok: true,
          seq,
          state: serializeState(game),
          events: ev,
        }
      }
      return { ok: false, error: 'bad_action' }
    } catch (err) {
      return { ok: false, error: 'illegal', detail: err && err.message }
    }
  }

  function sendChat(text) {
    const t = String(text || '')
      .trim()
      .slice(0, 280)
    if (!t || !connected) return { ok: false, error: 'not_connected' }
    write({ type: Msg.CHAT, text: t })
    bus.emit('chat', { from: 'local', text: t })
    return { ok: true }
  }

  /**
   * Mid-match reconnect without wiping game state.
   * Host: ensure topic discovery is up (usually already is).
   * Guest: re-join topic if needed; new swarm connection re-sends HELLO.
   */
  async function reconnectGame() {
    if (destroyed) throw new Error('session_destroyed')
    if (!role || !roomCode) throw new Error('no_session')

    emit('reconnecting', {
      role,
      roomCode,
      localPlayerName,
      remotePlayerName,
    })

    // Drop dead socket so swarm can accept / form a new link
    if (peerSocket) {
      try {
        peerSocket.destroy()
      } catch {
        /* ignore */
      }
      peerSocket = null
      connected = false
      clearPing()
      buf = ''
    }

    if (role === 'guest') {
      forceNextState = true
      matchEverStarted = true
    }

    const s = await ensureSwarm()
    if (!currentTopic) {
      currentTopic = topicFromRoomCode(roomCode)
    }
    // Re-announce on topic (safe if already joined)
    try {
      if (discovery) {
        try {
          await s.leave(currentTopic)
        } catch {
          /* ignore */
        }
        discovery = null
      }
      discovery = s.join(currentTopic, { server: true, client: true })
      Promise.resolve(discovery.flushed?.())
        .then(() => emit('discovery_ready', { roomCode, reconnect: true }))
        .catch((err) => bus.emit('error', err))
    } catch (err) {
      bus.emit('error', err)
      throw err
    }

    return {
      ok: true,
      role,
      roomCode,
      localPlayerName,
      peerLinked: Boolean(connected),
    }
  }

  async function destroyNetworking() {
    clearPing()
    if (swarmStatusTimer) {
      clearTimeout(swarmStatusTimer)
      swarmStatusTimer = null
    }
    await closeMatchLog()
    try {
      if (peerSocket) {
        try {
          write({ type: Msg.GOODBYE })
        } catch {
          /* ignore */
        }
        try {
          peerSocket.destroy()
        } catch {
          /* ignore */
        }
        peerSocket = null
      }
      if (discovery && currentTopic && swarm) {
        try {
          await swarm.leave(currentTopic)
        } catch {
          /* ignore */
        }
        discovery = null
      }
      currentTopic = null
      if (swarm) {
        try {
          await swarm.destroy()
        } catch {
          /* ignore */
        }
        swarm = null
      }
    } catch {
      /* ignore */
    }
    connected = false
    buf = ''
    lastEmittedPeers = -1
  }

  async function destroy() {
    destroyed = true
    await destroyNetworking()
    game = null
    role = null
    localSide = null
    roomCode = null
    seq = 0
    bus.removeAllListeners()
  }

  function getSnapshot() {
    // Snapshots used when opening UI — include legal for convenience
    return {
      ...buildGamePayload(null, null, null, { includeLegal: true }),
      localPlayerName,
      remotePlayerName,
      matchReady: Boolean(connected && game),
    }
  }

  function isDestroyed() {
    return destroyed
  }

  return {
    on: (name, fn) => bus.on(name, fn),
    off: (name, fn) => bus.off(name, fn),
    once: (name, fn) => bus.once(name, fn),
    hostGame,
    joinGame,
    reconnectGame,
    play,
    sendChat,
    destroy,
    getSnapshot,
    generateRoomCode,
    isDestroyed,
  }
}

module.exports = { createP2PSession }
