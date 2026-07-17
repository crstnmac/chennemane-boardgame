/**
 * Unified multiplayer transport surface for the game store.
 * - Electron/Pear → Hyperswarm (p2pBridge)
 * - Browser → PeerJS + MatchAuthority (webTransport)
 */
import {
  isPearDesktop,
  onP2PError as onPearError,
  onP2PGame as onPearGame,
  onP2PMatchReady as onPearMatchReady,
  onP2PReject as onPearReject,
  onP2PStatus as onPearStatus,
  p2pDestroy as pearDestroy,
  p2pHost as pearHost,
  p2pJoin as pearJoin,
  p2pPlay as pearPlay,
  p2pReconnect as pearReconnect,
  p2pSnapshot as pearSnapshot,
} from '../p2pBridge';
import type {
  P2PGamePayload,
  P2PHostOptions,
  P2PHostResult,
  P2PJoinResult,
  P2PMatchReadyPayload,
  P2PPlayAction,
  P2PPlayResult,
  P2PStatusPayload,
  P2PTransportKind,
} from './types';
import {
  createWebBus,
  isWebP2PSupported,
  setWebSessionDeadHandler,
  WebP2PTransport,
  type WebBus,
} from './webTransport';
import { sanitizePlayerName } from './protocol';

export type {
  P2PGamePayload,
  P2PHostOptions,
  P2PHostResult,
  P2PJoinResult,
  P2PMatchReadyPayload,
  P2PPlayAction,
  P2PPlayResult,
  P2PStatusPayload,
  P2PTransportKind,
};
export { isPearDesktop, isWebP2PSupported, sanitizePlayerName };
export { isValidGameState } from './protocol';

type ActiveSession = {
  kind: P2PTransportKind;
  web?: WebP2PTransport;
  bus?: WebBus;
};

let active: ActiveSession | null = null;
let bus: WebBus = createWebBus();

// Tab close / pagehide destroys Peer without going through p2pDestroy —
// clear the session handle so a restored page cannot use a dead transport.
setWebSessionDeadHandler(() => {
  if (active?.kind === 'web') active = null;
});

export function isP2PAvailable(): boolean {
  return isPearDesktop() || isWebP2PSupported();
}

export function p2pTransport(): P2PTransportKind | null {
  if (active) return active.kind;
  if (isPearDesktop()) return 'pear';
  if (isWebP2PSupported()) return 'web';
  return null;
}

export function p2pTransportLabel(): string {
  const t = p2pTransport();
  if (t === 'pear') return 'Pear P2P';
  if (t === 'web') return 'Online P2P';
  return '';
}

async function destroyActive() {
  if (!active) {
    if (isPearDesktop()) {
      try {
        await pearDestroy();
      } catch {
        /* ignore */
      }
    }
    return;
  }
  if (active.kind === 'web' && active.web) {
    await active.web.destroy();
  } else if (active.kind === 'pear') {
    try {
      await pearDestroy();
    } catch {
      /* ignore */
    }
  }
  active = null;
}

export async function p2pHost(opts: P2PHostOptions): Promise<P2PHostResult> {
  await destroyActive();
  if (isPearDesktop()) {
    active = { kind: 'pear' };
    const res = await pearHost(opts);
    return {
      roomCode: res.roomCode,
      localPlayerName: res.localPlayerName || sanitizePlayerName(opts.playerName),
      peerLinked: false,
    };
  }
  if (!isWebP2PSupported()) {
    throw new Error('P2P not available in this environment');
  }
  const web = new WebP2PTransport(bus);
  active = { kind: 'web', web, bus };
  try {
    return await web.host(opts);
  } catch (err) {
    await web.destroy();
    active = null;
    throw err;
  }
}

export async function p2pJoin(
  code: string,
  playerName?: string,
): Promise<P2PJoinResult> {
  await destroyActive();
  if (isPearDesktop()) {
    active = { kind: 'pear' };
    const res = await pearJoin(code, playerName);
    return {
      roomCode: res.roomCode,
      localPlayerName: res.localPlayerName || sanitizePlayerName(playerName),
      peerLinked: false,
    };
  }
  if (!isWebP2PSupported()) {
    throw new Error('P2P not available in this environment');
  }
  const web = new WebP2PTransport(bus);
  active = { kind: 'web', web, bus };
  try {
    return await web.join(code, playerName);
  } catch (err) {
    await web.destroy();
    active = null;
    throw err;
  }
}

export async function p2pPlay(action: P2PPlayAction): Promise<P2PPlayResult> {
  if (active?.kind === 'web' && active.web) {
    return active.web.play(action);
  }
  if (isPearDesktop()) {
    const res = await pearPlay(action);
    return res as P2PPlayResult;
  }
  return { ok: false, error: 'no_session' };
}

export async function p2pSnapshot(): Promise<P2PGamePayload> {
  if (active?.kind === 'web' && active.web) {
    return active.web.snapshot();
  }
  if (isPearDesktop()) {
    const snap = await pearSnapshot();
    return snap as P2PGamePayload;
  }
  return {
    state: null,
    seq: 0,
    localSide: null,
    role: null,
    roomCode: null,
    connected: false,
    terminal: false,
    winner: null,
    legal: [],
    yourTurn: false,
    events: [],
    reason: null,
    localPlayerName: null,
    remotePlayerName: null,
    matchReady: false,
  };
}

export async function p2pDestroy(): Promise<void> {
  await destroyActive();
}

/**
 * Reconnect after a drop without wiping match state.
 * Web guest: fresh PeerJS dial + HELLO(reconnect).
 * Pear: re-announce on Hyperswarm topic (session.reconnectGame).
 */
export async function p2pReconnect(_opts?: {
  code?: string;
  playerName?: string;
}): Promise<{ ok: boolean; error?: string }> {
  if (active?.kind === 'web' && active.web) {
    return active.web.reconnect();
  }
  if (isPearDesktop()) {
    try {
      const res = await pearReconnect();
      if (res && (res as { ok?: boolean }).ok === false) {
        return {
          ok: false,
          error: (res as { error?: string }).error || 'reconnect_failed',
        };
      }
      return { ok: true };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
  return { ok: false, error: 'no_session' };
}

export function onP2PGame(fn: (g: P2PGamePayload) => void): () => void {
  if (isPearDesktop()) {
    return onPearGame((g) => fn(g as P2PGamePayload));
  }
  bus.game.add(fn);
  return () => bus.game.delete(fn);
}

export function onP2PStatus(fn: (s: P2PStatusPayload) => void): () => void {
  if (isPearDesktop()) {
    return onPearStatus((s) => fn(s as P2PStatusPayload));
  }
  bus.status.add(fn);
  return () => bus.status.delete(fn);
}

export function onP2PMatchReady(fn: (m: P2PMatchReadyPayload) => void): () => void {
  if (isPearDesktop()) {
    return onPearMatchReady((m) => fn(m as P2PMatchReadyPayload));
  }
  bus.matchReady.add(fn);
  return () => bus.matchReady.delete(fn);
}

export function onP2PError(fn: (message: string) => void): () => void {
  if (isPearDesktop()) {
    return onPearError(fn);
  }
  bus.error.add(fn);
  return () => bus.error.delete(fn);
}

export function onP2PReject(fn: (reason: string) => void): () => void {
  if (isPearDesktop()) {
    return onPearReject(fn);
  }
  bus.reject.add(fn);
  return () => bus.reject.delete(fn);
}
