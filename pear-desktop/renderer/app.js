/**
 * Renderer UI — talks only to window.bridge (preload).
 * Game commands are JSON RPC over Bare worker IPC.
 */
;(function () {
  const bridge = window.bridge
  const WORKER = '/workers/main.js'
  const decoder = new TextDecoder('utf-8')

  const $ = (id) => document.getElementById(id)
  const el = {
    version: $('version'),
    conn: $('conn'),
    updateBtn: $('update-btn'),
    lobby: $('lobby'),
    match: $('match'),
    lobbyMsg: $('lobby-msg'),
    matchMsg: $('match-msg'),
    roomInput: $('room-input'),
    btnHost: $('btn-host'),
    btnJoin: $('btn-join'),
    btnLeave: $('btn-leave'),
    btnPass: $('btn-pass'),
    btnResign: $('btn-resign'),
    roleLabel: $('role-label'),
    roomLabel: $('room-label'),
    turnLabel: $('turn-label'),
    rowN: $('row-n'),
    rowS: $('row-s'),
    scoreS: $('score-s'),
    scoreN: $('score-n'),
    dir: $('dir'),
    chatLog: $('chat-log'),
    chatInput: $('chat-input'),
    btnChat: $('btn-chat'),
  }

  let lastGame = null
  let roomCode = null
  let busy = false
  let workerReady = false
  let reqId = 0
  const pending = new Map()

  const NORTH_PITS = [7, 8, 9, 10, 11, 12, 13]
  const SOUTH_PITS = [0, 1, 2, 3, 4, 5, 6]
  const LABELS = [
    'B1', 'B2', 'B3', 'B4', 'B5', 'B6', 'B7',
    'A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7',
  ]

  function setConn(text, mode) {
    el.conn.textContent = text
    el.conn.className = ('conn pill ' + (mode || '')).trim()
  }

  function setLobbyMsg(t) {
    el.lobbyMsg.textContent = t || ''
  }
  function setMatchMsg(t) {
    el.matchMsg.textContent = t || ''
  }

  function showMatch(show) {
    el.lobby.classList.toggle('hidden', show)
    el.match.classList.toggle('hidden', !show)
  }

  function callWorker(op, payload) {
    const id = ++reqId
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error('worker timeout: ' + op))
      }, 30_000)
      pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer)
          resolve(v)
        },
        reject: (e) => {
          clearTimeout(timer)
          reject(e)
        },
      })
      const msg = JSON.stringify({ type: 'cmd', id, op, payload: payload || null })
      bridge.writeWorkerIPC(WORKER, msg).catch((err) => {
        pending.delete(id)
        clearTimeout(timer)
        reject(err)
      })
    })
  }

  function handleWorkerMessage(raw) {
    const text = typeof raw === 'string' ? raw : decoder.decode(raw)

    // OTA string events from pear-runtime worker path
    if (text === 'updating') {
      setConn('Updating…', 'updating')
      el.version.textContent = 'UPDATING…'
      return
    }
    if (text === 'updated') {
      showUpdateReady()
      return
    }
    if (text === 'pear:updateApplied') return

    let msg
    try {
      msg = JSON.parse(text)
    } catch {
      console.log('[worker]', text)
      return
    }

    if (msg.type === 'res' && msg.id != null && pending.has(msg.id)) {
      const p = pending.get(msg.id)
      pending.delete(msg.id)
      if (msg.ok) p.resolve(msg.data)
      else p.reject(new Error(msg.error || 'worker error'))
      return
    }

    if (msg.type === 'evt') {
      onWorkerEvent(msg.name, msg.data)
    }
  }

  function onWorkerEvent(name, data) {
    if (name === 'ready' || name === 'worker_hello') {
      if (name === 'worker_hello' && data && data.ok === false) {
        workerReady = false
        el.btnHost.disabled = true
        el.btnJoin.disabled = true
        setConn('Worker failed', '')
        setLobbyMsg(data.error || 'Bare worker failed to start')
        return
      }
      workerReady = true
      el.btnHost.disabled = false
      el.btnJoin.disabled = false
      setConn(data && data.pearError ? 'Worker ready (OTA off)' : 'Worker ready', 'online')
      if (data && data.version) el.version.textContent = 'v' + data.version
      if (data && data.pearError) {
        setLobbyMsg('OTA unavailable: ' + data.pearError + ' — multiplayer still works.')
      }
      return
    }
    if (name === 'updating') {
      setConn('Updating…', 'updating')
      return
    }
    if (name === 'updated') {
      showUpdateReady()
      return
    }
    if (name === 'status') {
      if (data.connected || data.status === 'peer_connected') {
        setConn('Peer online', 'online')
      } else if (
        data.status === 'hosting' ||
        data.status === 'joining' ||
        data.status === 'peer_disconnected'
      ) {
        setConn(data.status === 'peer_disconnected' ? 'Peer left' : 'Waiting for peer', 'waiting')
      }
      if (data.roomCode) {
        roomCode = data.roomCode
        el.roomLabel.textContent = roomCode
      }
      return
    }
    if (name === 'game') {
      lastGame = data
      renderBoard()
      if (data.terminal) {
        const w = data.winner
        setMatchMsg(
          w === 'S' ? 'South wins the match.' : w === 'N' ? 'North wins the match.' : 'Match drawn.',
        )
      } else if (data.yourTurn) {
        setMatchMsg('Your turn — click a highlighted pit.')
      } else if (data.state) {
        setMatchMsg('Opponent to move.')
      }
      return
    }
    if (name === 'chat') {
      appendChat(data.from, data.text)
      return
    }
    if (name === 'reject') {
      setMatchMsg((data && (data.detail || data.reason)) || 'Action rejected')
      return
    }
    if (name === 'error') {
      setMatchMsg((data && data.message) || 'Error')
    }
  }

  function showUpdateReady() {
    el.version.textContent = 'Update ready'
    el.updateBtn.classList.remove('hidden')
    el.updateBtn.disabled = false
    el.updateBtn.textContent = 'Apply update'
    setConn('Update ready', 'updating')
  }

  function legalPits(legal, direction) {
    const set = new Set()
    for (const m of legal || []) {
      if (m.direction === direction) set.add(m.startPit)
    }
    return set
  }

  function renderBoard() {
    const g = lastGame
    const state = g && g.state
    const pits = (state && state.pits) || Array(14).fill(0)
    const toMove = state && state.toMove
    const dir = el.dir.value
    const legal = legalPits((g && g.legal) || [], dir)
    const canClick = Boolean(g && g.yourTurn && !g.terminal && !busy)

    function paint(rowEl, indices, side) {
      rowEl.replaceChildren()
      for (let n = 0; n < indices.length; n++) {
        const i = indices[n]
        const btn = document.createElement('button')
        btn.type = 'button'
        btn.className = 'pit'
        btn.dataset.pit = String(i)
        btn.textContent = String(pits[i] != null ? pits[i] : 0)
        btn.title = LABELS[i] || 'pit ' + i
        btn.setAttribute(
          'aria-label',
          (LABELS[i] || i) + ': ' + (pits[i] != null ? pits[i] : 0) + ' seeds',
        )
        if (toMove === side) btn.classList.add('to-move-row')
        if (canClick && legal.has(i)) {
          btn.classList.add('legal')
          btn.addEventListener('click', () => onPitClick(i))
        } else {
          btn.disabled = true
        }
        rowEl.appendChild(btn)
      }
    }

    paint(el.rowN, NORTH_PITS, 'N')
    paint(el.rowS, SOUTH_PITS, 'S')

    el.scoreS.textContent = String((state && state.score && state.score.S) || 0)
    el.scoreN.textContent = String((state && state.score && state.score.N) || 0)

    const role = (g && g.role) || '—'
    const side = (g && g.localSide) || '—'
    el.roleLabel.textContent =
      role + ' · ' + (side === 'S' ? 'South' : side === 'N' ? 'North' : side)
    el.roomLabel.textContent = roomCode || '—'

    if (g && g.terminal) {
      const w = g.winner
      const label =
        w === 'S' ? 'South wins' : w === 'N' ? 'North wins' : w == null ? 'Draw' : w + ' wins'
      el.turnLabel.textContent = 'Match over · ' + label
      el.btnPass.disabled = true
      el.btnResign.disabled = true
    } else if (g && g.yourTurn) {
      el.turnLabel.textContent = 'Your turn'
      el.btnPass.disabled = busy
      el.btnResign.disabled = busy
    } else if (state) {
      el.turnLabel.textContent = 'Waiting · ' + (toMove === 'S' ? 'South' : 'North')
      el.btnPass.disabled = true
      el.btnResign.disabled = false
    } else {
      el.turnLabel.textContent = 'Waiting for peer…'
      el.btnPass.disabled = true
      el.btnResign.disabled = true
    }
  }

  async function onPitClick(pit) {
    if (busy || !lastGame || !lastGame.yourTurn) return
    busy = true
    setMatchMsg('Sending move…')
    try {
      const res = await callWorker('play', {
        type: 'move',
        move: { startPit: pit, direction: el.dir.value },
      })
      if (res && res.ok === false) setMatchMsg(res.detail || res.error || 'Move rejected')
      else if (res && res.pending) setMatchMsg('Move sent — waiting for host…')
      else setMatchMsg('')
    } catch (err) {
      setMatchMsg(err.message || String(err))
    } finally {
      busy = false
      renderBoard()
    }
  }

  async function onPass() {
    if (busy) return
    busy = true
    try {
      const res = await callWorker('play', { type: 'pass' })
      if (res && res.ok === false) setMatchMsg(res.detail || res.error || 'Pass rejected')
    } catch (err) {
      setMatchMsg(err.message || String(err))
    } finally {
      busy = false
      renderBoard()
    }
  }

  async function onResign() {
    if (busy) return
    if (!confirm('Resign this match?')) return
    busy = true
    try {
      await callWorker('play', { type: 'resign' })
    } catch (err) {
      setMatchMsg(err.message || String(err))
    } finally {
      busy = false
      renderBoard()
    }
  }

  async function onHost() {
    if (!workerReady) return
    setLobbyMsg('Creating room…')
    el.btnHost.disabled = true
    el.btnJoin.disabled = true
    try {
      const res = await callWorker('host', {})
      roomCode = res.roomCode
      showMatch(true)
      setConn('Waiting for peer', 'waiting')
      setLobbyMsg('')
      setMatchMsg('Share room code: ' + roomCode)
      el.roomLabel.textContent = roomCode
      lastGame = await callWorker('snapshot')
      renderBoard()
    } catch (err) {
      setLobbyMsg(err.message || String(err))
    } finally {
      el.btnHost.disabled = false
      el.btnJoin.disabled = false
    }
  }

  async function onJoin() {
    if (!workerReady) return
    const code = el.roomInput.value.trim()
    if (code.length < 4) {
      setLobbyMsg('Enter a valid room code (4+ chars).')
      return
    }
    setLobbyMsg('Joining…')
    el.btnHost.disabled = true
    el.btnJoin.disabled = true
    try {
      const res = await callWorker('join', { code })
      roomCode = res.roomCode
      showMatch(true)
      setConn('Connecting…', 'waiting')
      setLobbyMsg('')
      setMatchMsg('Joined ' + roomCode + ' — looking for host on Hyperswarm…')
      lastGame = await callWorker('snapshot')
      renderBoard()
    } catch (err) {
      setLobbyMsg(err.message || String(err))
    } finally {
      el.btnHost.disabled = false
      el.btnJoin.disabled = false
    }
  }

  async function onLeave() {
    busy = true
    try {
      await callWorker('destroy')
    } catch {
      /* ignore */
    }
    lastGame = null
    roomCode = null
    if (el.chatLog) el.chatLog.replaceChildren()
    showMatch(false)
    setConn('Worker ready', 'online')
    setMatchMsg('')
    setLobbyMsg('Left room.')
    busy = false
  }

  function appendChat(from, text) {
    if (!el.chatLog || !text) return
    const line = document.createElement('div')
    line.className = 'line'
    const who = document.createElement('span')
    who.className = 'from'
    who.textContent =
      from === 'local' ? 'You' : from === 'host' ? 'Host' : from === 'guest' ? 'Guest' : String(from)
    line.appendChild(who)
    line.appendChild(document.createTextNode(text))
    el.chatLog.appendChild(line)
    el.chatLog.scrollTop = el.chatLog.scrollHeight
  }

  async function onChat() {
    const text = el.chatInput && el.chatInput.value && el.chatInput.value.trim()
    if (!text) return
    el.chatInput.value = ''
    try {
      await callWorker('chat', { text })
    } catch (err) {
      setMatchMsg(err.message || String(err))
    }
  }

  function wire() {
    if (!bridge) {
      setLobbyMsg('Preload bridge missing — open via Electron (npm start).')
      return
    }

    try {
      const pkg = bridge.pkg()
      if (pkg && pkg.version) el.version.textContent = 'v' + pkg.version
    } catch {
      /* ignore */
    }

    el.btnHost.addEventListener('click', () => onHost())
    el.btnJoin.addEventListener('click', () => onJoin())
    el.btnLeave.addEventListener('click', () => onLeave())
    el.btnPass.addEventListener('click', () => onPass())
    el.btnResign.addEventListener('click', () => onResign())
    el.btnChat.addEventListener('click', () => onChat())
    el.dir.addEventListener('change', () => renderBoard())
    el.roomInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') onJoin()
    })
    el.chatInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') onChat()
    })

    el.updateBtn.addEventListener('click', async () => {
      el.updateBtn.disabled = true
      el.updateBtn.textContent = 'Updating…'
      try {
        await bridge.applyUpdate()
        await bridge.appAfterUpdate()
      } catch (err) {
        el.version.textContent = 'Update failed: ' + (err.message || err)
        el.updateBtn.classList.add('hidden')
      }
    })

    bridge.onWorkerStdout(WORKER, (data) => {
      console.log('[worker stdout]', decoder.decode(data))
    })
    bridge.onWorkerStderr(WORKER, (data) => {
      console.error('[worker stderr]', decoder.decode(data))
    })
    bridge.onWorkerIPC(WORKER, (data) => {
      handleWorkerMessage(data)
    })
    bridge.onWorkerExit(WORKER, (code) => {
      workerReady = false
      el.btnHost.disabled = true
      el.btnJoin.disabled = true
      setConn('Worker exited (' + code + ')')
    })

    setConn('Starting worker…', 'waiting')
    bridge.startWorker(WORKER).catch((err) => {
      setLobbyMsg(err.message || String(err))
      setConn('Worker failed')
    })
  }

  wire()
  renderBoard()
})()
