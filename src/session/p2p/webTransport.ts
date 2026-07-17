/**
 * PeerJS WebRTC transport — thin layer over MatchAuthority.
 *
 * Disconnect detection (tab close often never fires DataConnection 'close'):
 * 1. Explicit GOODBYE on pagehide / beforeunload
 * 2. Heartbeat ping/pong; silence → peer_disconnected
 * 3. conn close / error as backup
 */
import type { DataConnection, Peer as PeerType } from 'peerjs';
import { MatchAuthority } from './authority';
import {
  APP_ID_WEB,
  encodeWire,
  errMessage,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_TIMEOUT_MS,
  Msg,
  parseWire,
  peerIdFromRoom,
  type WireMsg,
} from './protocol';
import type {
  P2PGamePayload,
  P2PHostOptions,
  P2PHostResult,
  P2PJoinResult,
  P2PMatchReadyPayload,
  P2PPlayAction,
  P2PPlayResult,
  P2PStatusPayload,
} from './types';

export type WebBus = {
  game: Set<(g: P2PGamePayload) => void>;
  status: Set<(s: P2PStatusPayload) => void>;
  matchReady: Set<(m: P2PMatchReadyPayload) => void>;
  error: Set<(message: string) => void>;
  reject: Set<(reason: string) => void>;
};

export function createWebBus(): WebBus {
  return {
    game: new Set(),
    status: new Set(),
    matchReady: new Set(),
    error: new Set(),
    reject: new Set(),
  };
}

let PeerCtor: typeof import('peerjs').default | null = null;

async function loadPeer(): Promise<typeof import('peerjs').default> {
  if (PeerCtor) return PeerCtor;
  const mod = await import('peerjs');
  PeerCtor = mod.default;
  return PeerCtor;
}

const RECONNECT_BASE_MS = 800;
const RECONNECT_MAX_MS = 8_000;
const RECONNECT_MAX_ATTEMPTS = 60;

export class WebP2PTransport {
  private peer: PeerType | null = null;
  private conn: DataConnection | null = null;
  private authority: MatchAuthority;
  private alive = true;
  private helloTimeout: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectAttempt = 0;
  private reconnectInFlight = false;
  private roomPeerId: string | null = null;
  private autoReconnect = true;
  private hostIncomingWired = false;
  private unloadWired = false;
  private lastPeerAliveAt = 0;
  private handlingGone = false;

  private readonly onPageLeave = () => {
    this.leaveBeacon();
  };

  constructor(private readonly bus: WebBus) {
    this.authority = new MatchAuthority({
      send: (msg) => this.send(msg),
      onStatus: (s) => {
        if (s.status === 'pong') {
          this.lastPeerAliveAt = Date.now();
          return;
        }
        for (const fn of this.bus.status) fn(s);
      },
      onGame: (g) => {
        for (const fn of this.bus.game) fn(g);
      },
      onMatchReady: (m) => {
        this.clearHelloTimeout();
        this.reconnectAttempt = 0;
        this.reconnectInFlight = false;
        this.lastPeerAliveAt = Date.now();
        this.startHeartbeat();
        for (const fn of this.bus.matchReady) fn(m);
      },
      onError: (message) => {
        for (const fn of this.bus.error) fn(message);
      },
      onReject: (reason) => {
        for (const fn of this.bus.reject) fn(reason);
      },
    });
  }

  private wireUnloadHandlers() {
    if (this.unloadWired || typeof window === 'undefined') return;
    this.unloadWired = true;
    // pagehide is the reliable signal on mobile + desktop tab close
    window.addEventListener('pagehide', this.onPageLeave);
    window.addEventListener('beforeunload', this.onPageLeave);
    // freeze (mobile background) — optional soft leave not needed
  }

  private unwireUnloadHandlers() {
    if (!this.unloadWired || typeof window === 'undefined') return;
    this.unloadWired = false;
    window.removeEventListener('pagehide', this.onPageLeave);
    window.removeEventListener('beforeunload', this.onPageLeave);
  }

  /**
   * Sync best-effort leave when the tab is dying.
   * Browsers allow little async work here — close/destroy must be immediate.
   */
  private leaveBeacon() {
    // Flags first so close/error handlers do not schedule auto-reconnect
    this.autoReconnect = false;
    this.alive = false;
    this.handlingGone = true;
    this.stopHeartbeat();
    this.clearHelloTimeout();
    this.clearReconnectTimer();
    try {
      if (this.conn?.open) {
        // Best-effort GOODBYE so the other side marks disconnect immediately
        this.conn.send(encodeWire({ type: Msg.GOODBYE }, APP_ID_WEB));
      }
    } catch {
      /* ignore */
    }
    try {
      this.conn?.close();
    } catch {
      /* ignore */
    }
    this.conn = null;
    try {
      // Destroying the Peer releases the room id (host) and signals ICE teardown
      this.peer?.destroy();
    } catch {
      /* ignore */
    }
    this.peer = null;
    this.hostIncomingWired = false;
    // Drop module session so a restored tab cannot use a dead transport
    onWebSessionDead?.();
  }

  private send(msg: WireMsg): boolean {
    if (!this.conn?.open) return false;
    try {
      this.conn.send(encodeWire(msg, APP_ID_WEB));
      return true;
    } catch (err) {
      for (const fn of this.bus.error) fn(errMessage(err));
      return false;
    }
  }

  private clearHelloTimeout() {
    if (this.helloTimeout) {
      clearTimeout(this.helloTimeout);
      this.helloTimeout = null;
    }
  }

  private clearReconnectTimer() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private startHeartbeat() {
    this.stopHeartbeat();
    this.lastPeerAliveAt = Date.now();
    this.heartbeatTimer = setInterval(() => {
      if (!this.alive) {
        this.stopHeartbeat();
        return;
      }
      if (!this.conn?.open) {
        this.handlePeerGone('channel_closed');
        return;
      }
      // Liveness probe
      this.send({ type: Msg.PING, t: Date.now() });
      if (Date.now() - this.lastPeerAliveAt > HEARTBEAT_TIMEOUT_MS) {
        this.handlePeerGone('heartbeat_timeout');
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  /** Remote left (GOODBYE), heartbeat died, or channel closed. */
  private handlePeerGone(_reason: string) {
    if (this.handlingGone || !this.alive) return;
    this.handlingGone = true;
    this.stopHeartbeat();
    this.clearHelloTimeout();

    const prev = this.conn;
    this.conn = null;
    if (prev) {
      try {
        prev.close();
      } catch {
        /* ignore */
      }
    }

    if (this.authority.isConnected || this.authority.hasHello()) {
      this.authority.onPeerDisconnected();
    } else {
      // Still emit so UI updates if we were mid-handshake
      for (const fn of this.bus.status) {
        fn({
          status: 'peer_disconnected',
          connected: false,
          role: this.authority.getRole(),
          roomCode: this.authority.getRoomCode(),
          localPlayerName: this.authority.getLocalPlayerName(),
          remotePlayerName: this.authority.getRemotePlayerName(),
        });
      }
    }

    this.handlingGone = false;
    this.scheduleAutoReconnect();
  }

  private isConnLive(conn: DataConnection | null): boolean {
    return Boolean(conn && conn.open);
  }

  private attachConn(conn: DataConnection, opts?: { reconnect?: boolean }) {
    // Prefer the new channel — stale PeerJS sockets often never fire 'close'
    if (this.conn && this.conn !== conn) {
      const old = this.conn;
      this.conn = null;
      this.stopHeartbeat();
      try {
        old.close();
      } catch {
        /* ignore */
      }
      this.authority.onPeerDisconnected();
    }

    this.conn = conn;
    this.reconnectInFlight = false;
    this.clearReconnectTimer();
    this.reconnectAttempt = 0;
    this.lastPeerAliveAt = Date.now();
    this.handlingGone = false;

    conn.on('data', (raw) => {
      this.lastPeerAliveAt = Date.now();
      // Fast-path control messages before authority
      const parsed = parseWire(raw);
      if (parsed.ok) {
        if (parsed.msg.type === Msg.PONG) {
          this.lastPeerAliveAt = Date.now();
          return;
        }
        if (parsed.msg.type === Msg.PING) {
          this.send({ type: Msg.PONG, t: parsed.msg.t ?? Date.now() });
          return;
        }
        if (parsed.msg.type === Msg.GOODBYE) {
          this.handlePeerGone('goodbye');
          return;
        }
      }
      this.authority.handleRaw(raw);
    });
    conn.on('close', () => {
      if (this.conn === conn || this.conn === null) {
        if (this.conn === conn) this.conn = null;
        this.handlePeerGone('close');
      }
    });
    conn.on('error', (err) => {
      for (const fn of this.bus.error) fn(errMessage(err));
      if (this.conn === conn && !conn.open) {
        this.handlePeerGone('error');
      }
    });

    // Data channel is open — guest sends HELLO immediately
    this.authority.onPeerConnected({
      reconnect: opts?.reconnect || this.authority.hasMatchStarted(),
    });
    // Start heartbeat once channel is up (even before HELLO completes)
    this.startHeartbeat();

    // Host: guest must HELLO within 20s on this channel
    if (this.authority.getRole() === 'host') {
      this.clearHelloTimeout();
      this.helloTimeout = setTimeout(() => {
        if (!this.alive || this.conn !== conn) return;
        if (!this.authority.hasHello()) {
          for (const fn of this.bus.error) {
            fn('Opponent connected but did not join in time');
          }
          this.handlePeerGone('hello_timeout');
        }
      }, 20_000);
    }
  }

  private scheduleAutoReconnect() {
    if (!this.alive || !this.autoReconnect) return;
    if (this.authority.getRole() !== 'guest') return;
    if (this.reconnectInFlight) return;
    if (this.isConnLive(this.conn)) return;
    if (this.reconnectAttempt >= RECONNECT_MAX_ATTEMPTS) {
      for (const fn of this.bus.error) {
        fn('Could not reconnect — host may have left. Leave and rejoin with the room code.');
      }
      return;
    }
    const delay = Math.min(
      RECONNECT_MAX_MS,
      RECONNECT_BASE_MS * Math.pow(1.3, this.reconnectAttempt),
    );
    this.reconnectAttempt += 1;
    this.clearReconnectTimer();
    for (const fn of this.bus.status) {
      fn({
        status: 'reconnecting',
        connected: false,
        role: 'guest',
        roomCode: this.authority.getRoomCode(),
        localPlayerName: this.authority.getLocalPlayerName(),
        remotePlayerName: this.authority.getRemotePlayerName(),
      });
    }
    this.reconnectTimer = setTimeout(() => {
      void this.reconnect()
        .then((res) => {
          if (!res.ok) this.scheduleAutoReconnect();
        })
        .catch(() => {
          this.scheduleAutoReconnect();
        });
    }, delay);
  }

  private async createPeer(id?: string): Promise<PeerType> {
    const Peer = await loadPeer();
    return new Promise((resolve, reject) => {
      const peer = id ? new Peer(id, { debug: 0 }) : new Peer({ debug: 0 });
      let settled = false;
      const fail = (err: unknown) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(t);
        try {
          peer.destroy();
        } catch {
          /* ignore */
        }
        reject(new Error(errMessage(err)));
      };
      const t = window.setTimeout(() => {
        fail(new Error('PeerJS connection timeout — check network'));
      }, 20_000);
      peer.on('open', () => {
        if (settled) return;
        settled = true;
        window.clearTimeout(t);
        resolve(peer);
      });
      peer.on('error', fail);
    });
  }

  private wireHostIncoming() {
    if (!this.peer || this.hostIncomingWired) return;
    this.hostIncomingWired = true;
    this.peer.on('connection', (conn) => {
      if (!this.alive) {
        try {
          conn.close();
        } catch {
          /* ignore */
        }
        return;
      }
      const accept = () => {
        this.attachConn(conn, { reconnect: this.authority.hasMatchStarted() });
      };
      if (conn.open) {
        accept();
      } else {
        conn.on('open', accept);
      }
    });
    this.peer.on('error', (err) => {
      for (const fn of this.bus.error) fn(errMessage(err));
    });
    this.peer.on('disconnected', () => {
      if (!this.alive || !this.peer || this.peer.destroyed) return;
      try {
        this.peer.reconnect();
      } catch {
        /* ignore */
      }
    });
  }

  async host(opts: P2PHostOptions): Promise<P2PHostResult> {
    this.alive = true;
    this.autoReconnect = true;
    this.wireUnloadHandlers();
    const prepared = this.authority.prepareHost(opts);
    this.roomPeerId = peerIdFromRoom(prepared.roomCode);
    this.hostIncomingWired = false;
    this.peer = await this.createPeer(this.roomPeerId);
    this.wireHostIncoming();
    return {
      roomCode: prepared.roomCode,
      localPlayerName: prepared.localPlayerName,
      peerLinked: false,
    };
  }

  async join(code: string, playerName?: string): Promise<P2PJoinResult> {
    this.alive = true;
    this.autoReconnect = true;
    this.wireUnloadHandlers();
    const prepared = this.authority.prepareJoin(code, playerName);
    this.roomPeerId = peerIdFromRoom(prepared.roomCode);
    this.peer = await this.createPeer();
    await this.dialHost(false);
    return {
      roomCode: prepared.roomCode,
      localPlayerName: prepared.localPlayerName,
      peerLinked: true,
    };
  }

  private async dialHost(isReconnect: boolean): Promise<void> {
    const hostId = this.roomPeerId || peerIdFromRoom(this.authority.getRoomCode() || '');
    if (!hostId) throw new Error('no_room');
    if (!this.peer || this.peer.destroyed) {
      this.peer = await this.createPeer();
    }
    if (this.peer.disconnected) {
      await new Promise<void>((resolve, reject) => {
        const t = window.setTimeout(() => reject(new Error('signaling reconnect timeout')), 15_000);
        this.peer!.once('open', () => {
          window.clearTimeout(t);
          resolve();
        });
        try {
          this.peer!.reconnect();
        } catch (err) {
          window.clearTimeout(t);
          reject(err);
        }
      });
    }
    const conn = this.peer.connect(hostId, { reliable: true, serialization: 'json' });
    await this.waitConnOpen(conn, isReconnect ? 15_000 : 25_000);
    this.attachConn(conn, { reconnect: isReconnect });
  }

  private waitConnOpen(conn: DataConnection, timeoutMs = 25_000): Promise<void> {
    return new Promise((resolve, reject) => {
      if (conn.open) {
        resolve();
        return;
      }
      let settled = false;
      const finish = (err?: unknown) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(t);
        try {
          conn.off('open', onOpen);
          conn.off('error', onErr);
        } catch {
          /* ignore */
        }
        if (err) reject(err instanceof Error ? err : new Error(errMessage(err)));
        else resolve();
      };
      const onOpen = () => finish();
      const onErr = (err: unknown) => finish(err);
      const t = window.setTimeout(() => {
        finish(new Error('Could not reach host — check room code and that they are waiting'));
      }, timeoutMs);
      conn.on('open', onOpen);
      conn.on('error', onErr);
    });
  }

  async reconnect(): Promise<{ ok: boolean; error?: string }> {
    if (!this.alive) return { ok: false, error: 'destroyed' };
    const role = this.authority.getRole();

    if (role === 'host') {
      if (this.peer && !this.peer.destroyed && this.peer.disconnected) {
        try {
          this.peer.reconnect();
        } catch (err) {
          return { ok: false, error: errMessage(err) };
        }
      }
      return { ok: true };
    }

    if (role !== 'guest') return { ok: false, error: 'no_session' };
    if (this.reconnectInFlight) return { ok: false, error: 'busy' };
    if (this.isConnLive(this.conn)) return { ok: true };

    this.reconnectInFlight = true;
    this.autoReconnect = true;
    this.authority.beginGuestReconnect();
    this.clearReconnectTimer();
    this.stopHeartbeat();

    if (this.conn) {
      try {
        this.conn.close();
      } catch {
        /* ignore */
      }
      this.conn = null;
    }

    try {
      try {
        this.peer?.destroy();
      } catch {
        /* ignore */
      }
      this.peer = null;
      this.peer = await this.createPeer();
      await this.dialHost(true);
      this.reconnectInFlight = false;
      this.reconnectAttempt = 0;
      return { ok: true };
    } catch (err) {
      this.reconnectInFlight = false;
      return { ok: false, error: errMessage(err) };
    }
  }

  play(action: P2PPlayAction): P2PPlayResult {
    return this.authority.play(action);
  }

  snapshot(): P2PGamePayload {
    return this.authority.getSnapshot();
  }

  async destroy() {
    this.unwireUnloadHandlers();
    this.alive = false;
    this.autoReconnect = false;
    this.handlingGone = true;
    this.clearHelloTimeout();
    this.clearReconnectTimer();
    this.stopHeartbeat();
    // Intentional leave — tell peer if still connected
    try {
      if (this.conn?.open) {
        this.conn.send(encodeWire({ type: Msg.GOODBYE }, APP_ID_WEB));
      }
    } catch {
      /* ignore */
    }
    try {
      this.conn?.close();
    } catch {
      /* ignore */
    }
    this.conn = null;
    try {
      this.peer?.destroy();
    } catch {
      /* ignore */
    }
    this.peer = null;
    this.hostIncomingWired = false;
    this.authority.destroy();
  }
}

export function isWebP2PSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof RTCPeerConnection !== 'undefined' &&
    typeof crypto !== 'undefined' &&
    typeof crypto.getRandomValues === 'function'
  );
}

/** Cleared by p2p/index when tab unload kills the session. */
let onWebSessionDead: (() => void) | null = null;

export function setWebSessionDeadHandler(fn: (() => void) | null) {
  onWebSessionDead = fn;
}
