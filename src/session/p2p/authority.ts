/**
 * Host-authoritative match logic shared by transports.
 * Transport only provides send/connect; this owns game + wire protocol.
 */
import {
  applyMove,
  applyPass,
  cloneState,
  createGame,
  getWinner,
  isTerminal,
  resign as engineResign,
  type GameState,
  type MoveEvent,
} from '../../engine';
import {
  capEvents,
  errMessage,
  generateRoomCode,
  isMoveIntent,
  isPassIntent,
  isResignIntent,
  isValidGameState,
  MAX_WIRE_EVENTS,
  Msg,
  normalizeRoomCode,
  parseWire,
  PROTOCOL_VERSION,
  sanitizePlayerName,
  slimConfig,
  type WireMsg,
} from './protocol';
import type {
  P2PGamePayload,
  P2PHostOptions,
  P2PMatchReadyPayload,
  P2PPlayAction,
  P2PPlayResult,
  P2PRole,
  P2PStatusPayload,
} from './types';

export type AuthoritySink = {
  send: (msg: WireMsg) => boolean;
  onStatus: (s: P2PStatusPayload) => void;
  onGame: (g: P2PGamePayload) => void;
  onMatchReady: (m: P2PMatchReadyPayload) => void;
  onError: (message: string) => void;
  onReject: (reason: string) => void;
};

export class MatchAuthority {
  private role: P2PRole | null = null;
  private localSide: 'S' | 'N' | null = null;
  private roomCode: string | null = null;
  private game: GameState | null = null;
  private seq = 0;
  private connected = false;
  private alive = true;
  private localPlayerName = 'Player';
  private remotePlayerName: string | null = null;
  /** Host has accepted a peer HELLO while connected (cleared on disconnect). */
  private helloReceived = false;
  /** Host has completed at least one match HELLO (survives disconnects). */
  private matchEverStarted = false;
  /** Guest: force next STATE apply even if seq matches (reconnect resync). */
  private forceNextState = false;

  constructor(private readonly sink: AuthoritySink) {}

  get isAlive() {
    return this.alive;
  }

  get isConnected() {
    return this.connected;
  }

  getRole() {
    return this.role;
  }

  getRoomCode() {
    return this.roomCode;
  }

  getLocalPlayerName() {
    return this.localPlayerName;
  }

  getRemotePlayerName() {
    return this.remotePlayerName;
  }

  /** Host: true after current channel completed HELLO (cleared on disconnect). */
  hasHello() {
    return this.helloReceived;
  }

  /** True once the match has started (survives disconnect for reconnect). */
  hasMatchStarted() {
    return this.matchEverStarted;
  }

  private serializeState(state: GameState): GameState {
    const c = cloneState(state);
    c.config = slimConfig(c.config);
    return c;
  }

  private emitStatus(status: string, extra: Partial<P2PStatusPayload> = {}) {
    this.sink.onStatus({
      status,
      role: this.role,
      localSide: this.localSide,
      roomCode: this.roomCode,
      connected: this.connected,
      localPlayerName: this.localPlayerName,
      remotePlayerName: this.remotePlayerName,
      ...extra,
    });
  }

  private buildGamePayload(
    reason: string | null,
    events: MoveEvent[] | null,
  ): P2PGamePayload {
    const g = this.game;
    const terminal = g ? isTerminal(g) : false;
    return {
      state: g ? this.serializeState(g) : null,
      seq: this.seq,
      localSide: this.localSide,
      role: this.role,
      roomCode: this.roomCode,
      connected: this.connected,
      terminal,
      winner: terminal && g ? getWinner(g) : null,
      legal: [],
      yourTurn: Boolean(
        g && this.localSide && g.toMove === this.localSide && !terminal && this.connected,
      ),
      events: events && events.length ? events : [],
      reason,
      localPlayerName: this.localPlayerName,
      remotePlayerName: this.remotePlayerName,
      matchReady: Boolean(this.connected && g && (this.role === 'guest' || this.helloReceived)),
    };
  }

  private emitGame(reason: string | null, events: MoveEvent[] | null) {
    this.sink.onGame(this.buildGamePayload(reason, events));
  }

  private emitMatchReady() {
    this.sink.onMatchReady({
      localPlayerName: this.localPlayerName,
      remotePlayerName: this.remotePlayerName,
      roomCode: this.roomCode,
      role: this.role,
      localSide: this.localSide,
    });
  }

  private write(msg: WireMsg) {
    return this.sink.send(msg);
  }

  private broadcastState(reason: string, events: MoveEvent[] | null) {
    if (!this.game) return;
    const serialized = this.serializeState(this.game);
    const ev = capEvents(events);
    const reasonOut =
      ev.length === 0 && events && events.length > MAX_WIRE_EVENTS ? 'snapshot' : reason;
    this.write({
      type: Msg.STATE,
      seq: this.seq,
      reason: reasonOut,
      state: serialized,
      events: ev,
      hostName: this.role === 'host' ? this.localPlayerName : this.remotePlayerName,
      guestName: this.role === 'host' ? this.remotePlayerName : this.localPlayerName,
    });
    this.emitGame(reasonOut, ev);
  }

  /** Prepare host match (no peer yet). */
  prepareHost(opts: P2PHostOptions): { roomCode: string; localPlayerName: string } {
    this.alive = true;
    this.role = 'host';
    this.localSide = 'S';
    this.localPlayerName = sanitizePlayerName(opts.playerName);
    this.remotePlayerName = null;
    this.helloReceived = false;
    this.matchEverStarted = false;
    this.forceNextState = false;
    this.connected = false;
    this.roomCode = generateRoomCode(6);
    this.game = createGame(
      {
        directionMode:
          (opts.directionMode as GameState['config']['directionMode']) || 'bidirectional',
        initialSeedsPerPit: opts.seeds || 5,
        matchStructure: opts.multiRound ? 'multi-round-protected' : 'single',
        residual: (opts.residual as GameState['config']['residual']) || 'unclaimed',
      },
      { firstPlayer: (opts.firstPlayer as 'S' | 'N') || 'S' },
    );
    this.seq = 1;
    this.emitStatus('hosting');
    return { roomCode: this.roomCode, localPlayerName: this.localPlayerName };
  }

  /** Prepare guest before transport connect. */
  prepareJoin(code: string, playerName?: string): { roomCode: string; localPlayerName: string } {
    this.alive = true;
    this.role = 'guest';
    this.localSide = 'N';
    this.localPlayerName = sanitizePlayerName(playerName);
    this.remotePlayerName = null;
    this.helloReceived = false;
    this.matchEverStarted = false;
    this.forceNextState = false;
    this.connected = false;
    this.roomCode = normalizeRoomCode(code);
    if (this.roomCode.length < 4) throw new Error('room_code_too_short');
    this.game = null;
    this.seq = 0;
    this.emitStatus('joining');
    return { roomCode: this.roomCode, localPlayerName: this.localPlayerName };
  }

  /**
   * Peer data channel / socket is open.
   * Guest sends HELLO (fresh join or reconnect); host waits for HELLO.
   */
  onPeerConnected(opts?: { reconnect?: boolean }) {
    if (!this.alive) return;
    if (this.role === 'guest') {
      // Guest is fully linked once the channel is open (HELLO is outbound)
      this.connected = true;
      const isReconnect =
        this.matchEverStarted ||
        Boolean(this.game && this.seq > 0) ||
        Boolean(opts?.reconnect);
      if (isReconnect) {
        this.forceNextState = true;
        this.matchEverStarted = true;
      }
      this.emitStatus(isReconnect ? 'reconnecting' : 'peer_connected', {
        connected: true,
      });
      const sent = this.write({
        type: Msg.HELLO,
        role: 'guest',
        side: 'N',
        protocol: PROTOCOL_VERSION,
        playerName: this.localPlayerName,
        reconnect: isReconnect,
        lastSeq: this.seq,
      });
      if (!sent) {
        this.sink.onError('failed_to_send_hello');
      }
    } else {
      // Host: data channel open does NOT mean match is ready — wait for HELLO
      // so we never allow host moves or "opponent joined" before the guest is real.
      this.connected = false;
      this.helloReceived = false;
      this.emitStatus('channel_open', {
        connected: false,
        roomCode: this.roomCode,
        localPlayerName: this.localPlayerName,
      });
    }
  }

  onPeerDisconnected() {
    if (!this.alive) return;
    this.connected = false;
    // Keep remotePlayerName so UI can say "waiting for Maya"
    this.helloReceived = false;
    this.emitStatus('peer_disconnected', {
      connected: false,
      remotePlayerName: this.remotePlayerName,
    });
  }

  /** Guest transport about to dial host again — keep game memory. */
  beginGuestReconnect() {
    if (this.role !== 'guest') return;
    this.connected = false;
    this.forceNextState = true;
    this.emitStatus('reconnecting', {
      connected: false,
      roomCode: this.roomCode,
      localPlayerName: this.localPlayerName,
      remotePlayerName: this.remotePlayerName,
    });
  }

  handleRaw(raw: unknown) {
    const parsed = parseWire(raw);
    if (!parsed.ok) {
      if (parsed.error === 'version_mismatch') {
        this.write({ type: Msg.REJECT, reason: 'version_mismatch' });
      } else if (parsed.error === 'payload_too_large') {
        this.sink.onError('payload_too_large');
      }
      return;
    }
    this.handleMessage(parsed.msg);
  }

  private handleMessage(msg: WireMsg) {
    if (msg.type === Msg.PING) {
      this.write({ type: Msg.PONG, t: msg.t ?? Date.now() });
      return;
    }
    if (msg.type === Msg.PONG) {
      // Transport may also track this for liveness
      this.sink.onStatus({
        status: 'pong',
        connected: this.connected,
        role: this.role,
        roomCode: this.roomCode,
        localPlayerName: this.localPlayerName,
        remotePlayerName: this.remotePlayerName,
      });
      return;
    }
    if (msg.type === Msg.GOODBYE) {
      // Single disconnect path (do not double-emit peer_goodbye after)
      this.onPeerDisconnected();
      return;
    }

    if (msg.type === Msg.HELLO && this.role === 'host') {
      // Reject only if we already completed HELLO on a live link.
      // Reconnect path clears helloReceived on disconnect before new HELLO.
      if (this.helloReceived && this.connected) {
        this.write({ type: Msg.REJECT, reason: 'room_full' });
        return;
      }
      // Match is live only after guest HELLO (not merely channel open)
      this.connected = true;
      this.helloReceived = true;
      this.remotePlayerName = sanitizePlayerName(msg.playerName);
      // First HELLO of the room is a join; later HELLOs (after a drop) are reconnects
      const isReconnect = this.matchEverStarted || Boolean(msg.reconnect);
      this.matchEverStarted = true;
      this.write({
        type: Msg.WELCOME,
        role: 'guest',
        side: 'N',
        roomCode: this.roomCode,
        hostSide: 'S',
        hostName: this.localPlayerName,
        guestName: this.remotePlayerName,
        reconnect: isReconnect,
      });
      if (!this.game) {
        this.game = createGame(
          { directionMode: 'bidirectional', initialSeedsPerPit: 5 },
          { firstPlayer: 'S' },
        );
        this.seq = 1;
      }
      // Reconnect: resync full board (no move events); first join: welcome
      this.broadcastState(isReconnect ? 'reconnect' : 'welcome', []);
      this.emitMatchReady();
      this.emitStatus(isReconnect ? 'peer_reconnected' : 'peer_connected', {
        connected: true,
      });
      return;
    }

    if (msg.type === Msg.WELCOME && this.role === 'guest') {
      this.localSide = msg.side === 'S' ? 'S' : 'N';
      this.roomCode = (msg.roomCode as string) || this.roomCode;
      this.remotePlayerName = sanitizePlayerName(msg.hostName);
      // Keep a real local nickname; only fill from host echo if we have default
      if (msg.guestName) {
        const gName = sanitizePlayerName(msg.guestName);
        if (
          gName &&
          gName !== 'Player' &&
          (!this.localPlayerName || this.localPlayerName === 'Player')
        ) {
          this.localPlayerName = gName;
        }
      }
      this.matchEverStarted = true;
      if (msg.reconnect) this.forceNextState = true;
      this.emitMatchReady();
      this.emitStatus(msg.reconnect ? 'peer_reconnected' : 'peer_connected', {
        connected: true,
      });
      return;
    }

    if (msg.type === Msg.STATE && this.role === 'guest') {
      if (!isValidGameState(msg.state)) {
        this.sink.onError('invalid_state_payload');
        return;
      }
      const incomingSeq = typeof msg.seq === 'number' ? msg.seq : this.seq;
      const reasonHint = (msg.reason as string) || 'state';
      const force =
        this.forceNextState ||
        reasonHint === 'reconnect' ||
        reasonHint === 'welcome';
      if (incomingSeq < this.seq && !force) return;
      if (incomingSeq === this.seq && this.game && !force) return;
      this.forceNextState = false;
      this.game = msg.state;
      this.seq = incomingSeq;
      // Names on STATE: hostName is always the opponent for guest.
      // Never clobber a real local name with a default echo from host.
      if (msg.hostName) this.remotePlayerName = sanitizePlayerName(msg.hostName);
      if (msg.guestName) {
        const gName = sanitizePlayerName(msg.guestName);
        if (
          gName &&
          gName !== 'Player' &&
          (!this.localPlayerName || this.localPlayerName === 'Player')
        ) {
          this.localPlayerName = gName;
        }
      }
      const rawEvents = Array.isArray(msg.events) ? (msg.events as MoveEvent[]) : [];
      const ev = force ? [] : capEvents(rawEvents);
      const reason =
        force
          ? reasonHint === 'welcome'
            ? 'welcome'
            : 'reconnect'
          : ev.length === 0 && rawEvents.length > MAX_WIRE_EVENTS
            ? 'snapshot'
            : reasonHint;
      this.emitGame(reason, ev);
      return;
    }

    if (msg.type === Msg.REJECT) {
      this.sink.onReject(String(msg.detail || msg.reason || 'rejected'));
      return;
    }

    if (this.role === 'host') {
      this.handleHostIntent(msg);
    }
  }

  private handleHostIntent(msg: WireMsg) {
    if (!this.game || isTerminal(this.game)) {
      this.write({ type: Msg.REJECT, reason: 'game_over' });
      return;
    }
    try {
      if (isResignIntent(msg)) {
        const result = engineResign(this.game, 'N');
        this.game = result.state;
        this.seq += 1;
        const ev = capEvents(result.events);
        this.broadcastState(ev.length ? 'resign' : 'snapshot', ev);
        return;
      }
      if (this.game.toMove !== 'N') {
        this.write({ type: Msg.REJECT, reason: 'not_your_turn' });
        return;
      }
      if (isMoveIntent(msg)) {
        const result = applyMove(this.game, msg.move);
        this.game = result.state;
        this.seq += 1;
        const ev = capEvents(result.events);
        this.broadcastState(
          ev.length ? 'move' : result.events.length ? 'snapshot' : 'move',
          ev,
        );
        return;
      }
      if (isPassIntent(msg)) {
        const result = applyPass(this.game);
        this.game = result.state;
        this.seq += 1;
        const ev = capEvents(result.events);
        this.broadcastState('pass', ev);
        return;
      }
      this.write({ type: Msg.REJECT, reason: 'unknown_intent' });
    } catch (err) {
      this.write({
        type: Msg.REJECT,
        reason: 'illegal',
        detail: errMessage(err),
      });
    }
  }

  play(action: P2PPlayAction): P2PPlayResult {
    if (!this.alive) return { ok: false, error: 'destroyed' };
    if (!this.game || !this.localSide) return { ok: false, error: 'no_game' };
    if (!this.connected) return { ok: false, error: 'waiting_for_peer' };
    // Host must have completed HELLO so guest has the board
    if (this.role === 'host' && !this.helloReceived) {
      return { ok: false, error: 'waiting_for_peer' };
    }
    if (isTerminal(this.game)) return { ok: false, error: 'game_over' };

    if (action.type === 'resign') {
      if (this.role === 'guest') {
        this.write({ type: Msg.RESIGN });
        return { ok: true, pending: true };
      }
      try {
        const result = engineResign(this.game, this.localSide);
        this.game = result.state;
        this.seq += 1;
        const ev = capEvents(result.events);
        this.broadcastState(ev.length ? 'resign' : 'snapshot', ev);
        return {
          ok: true,
          seq: this.seq,
          state: this.serializeState(this.game),
          events: ev,
        };
      } catch (err) {
        return { ok: false, error: 'illegal', detail: errMessage(err) };
      }
    }

    if (this.game.toMove !== this.localSide) {
      return { ok: false, error: 'not_your_turn' };
    }

    if (this.role === 'guest') {
      if (action.type === 'move' && action.move) {
        this.write({ type: Msg.MOVE, move: action.move });
        return { ok: true, pending: true };
      }
      if (action.type === 'pass') {
        this.write({ type: Msg.PASS });
        return { ok: true, pending: true };
      }
      return { ok: false, error: 'bad_action' };
    }

    // Host applies locally
    try {
      if (action.type === 'move' && action.move) {
        if (
          !Number.isInteger(action.move.startPit) ||
          action.move.startPit < 0 ||
          action.move.startPit > 13
        ) {
          return { ok: false, error: 'illegal', detail: 'bad_pit' };
        }
        const result = applyMove(this.game, action.move);
        this.game = result.state;
        this.seq += 1;
        const ev = capEvents(result.events);
        this.broadcastState(
          ev.length ? 'move' : result.events.length ? 'snapshot' : 'move',
          ev,
        );
        return {
          ok: true,
          seq: this.seq,
          state: this.serializeState(this.game),
          events: ev,
        };
      }
      if (action.type === 'pass') {
        const result = applyPass(this.game);
        this.game = result.state;
        this.seq += 1;
        const ev = capEvents(result.events);
        this.broadcastState('pass', ev);
        return {
          ok: true,
          seq: this.seq,
          state: this.serializeState(this.game),
          events: ev,
        };
      }
      return { ok: false, error: 'bad_action' };
    } catch (err) {
      return { ok: false, error: 'illegal', detail: errMessage(err) };
    }
  }

  getSnapshot(): P2PGamePayload {
    return this.buildGamePayload(null, []);
  }

  destroy() {
    this.alive = false;
    this.connected = false;
    this.game = null;
    this.role = null;
    this.localSide = null;
    this.roomCode = null;
    this.seq = 0;
    this.remotePlayerName = null;
    this.helloReceived = false;
    this.matchEverStarted = false;
    this.forceNextState = false;
  }
}
