/**
 * Pear desktop P2P bridge — talks to Bare worker via Electron preload.
 * Browser builds: isPearDesktop() is false; use PeerJS via ./p2p instead.
 */
import type {
  P2PGamePayload as SharedGamePayload,
  P2PMatchReadyPayload as SharedMatchReady,
  P2PRole,
  P2PStatusPayload as SharedStatus,
} from './p2p/types';

export type { P2PRole };
export type P2PGamePayload = SharedGamePayload & {
  state: unknown | null;
  events?: unknown[] | null;
};
export type P2PStatusPayload = SharedStatus;
export type P2PMatchReadyPayload = SharedMatchReady;

type Bridge = {
  startWorker: (specifier: string) => Promise<boolean>;
  writeWorkerIPC: (specifier: string, data: string | ArrayBufferView) => Promise<unknown>;
  onWorkerIPC: (
    specifier: string,
    listener: (data: Uint8Array | ArrayBuffer | string) => void,
  ) => () => void;
  onWorkerStdout?: (specifier: string, listener: (data: Uint8Array) => void) => () => void;
  onWorkerStderr?: (specifier: string, listener: (data: Uint8Array) => void) => () => void;
  onWorkerExit?: (specifier: string, listener: (code: number) => void) => () => void;
  pkg?: () => { version?: string; productName?: string };
};

const WORKER = '/workers/main.js';
const MAX_PENDING = 32;

declare global {
  interface Window {
    bridge?: Bridge;
  }
}

export function isPearDesktop(): boolean {
  return typeof window !== 'undefined' && Boolean(window.bridge?.startWorker);
}

function getBridge(): Bridge {
  if (!window.bridge) throw new Error('Pear bridge unavailable (not running in Electron)');
  return window.bridge;
}

let started = false;
let starting: Promise<void> | null = null;
let reqId = 0;
const pending = new Map<
  number,
  { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }
>();

const gameListeners = new Set<(g: P2PGamePayload) => void>();
const statusListeners = new Set<(s: P2PStatusPayload) => void>();
const matchReadyListeners = new Set<(m: P2PMatchReadyPayload) => void>();
const errorListeners = new Set<(message: string) => void>();
const rejectListeners = new Set<(reason: string) => void>();

let unsubIpc: (() => void) | null = null;
let unsubStderr: (() => void) | null = null;
let unsubExit: (() => void) | null = null;

function decode(data: Uint8Array | ArrayBuffer | string): string {
  if (typeof data === 'string') return data;
  return new TextDecoder().decode(data instanceof ArrayBuffer ? new Uint8Array(data) : data);
}

function clearAllPending(err: Error) {
  for (const [, p] of pending) {
    clearTimeout(p.timer);
    p.reject(err);
  }
  pending.clear();
}

function handleIpcRaw(raw: string) {
  if (raw === 'updating' || raw === 'updated' || raw === 'pear:updateApplied') return;

  let msg: {
    type?: string;
    id?: number;
    ok?: boolean;
    data?: unknown;
    error?: string | null;
    name?: string;
  };
  try {
    msg = JSON.parse(raw);
  } catch {
    return;
  }

  if (msg.type === 'res' && msg.id != null && pending.has(msg.id)) {
    const p = pending.get(msg.id)!;
    pending.delete(msg.id);
    clearTimeout(p.timer);
    // Logical failures (illegal move, not your turn) return structured data —
    // resolve so callers can read `detail` without losing it in a bare Error.
    if (msg.ok) {
      p.resolve(msg.data);
    } else if (msg.data != null && typeof msg.data === 'object') {
      p.resolve({
        ...(msg.data as object),
        ok: false,
        error: msg.error || (msg.data as { error?: string }).error || 'worker error',
      });
    } else {
      p.reject(new Error(msg.error || 'worker error'));
    }
    return;
  }

  if (msg.type === 'evt') {
    if (msg.name === 'game') {
      const g = msg.data as P2PGamePayload;
      for (const fn of gameListeners) {
        try {
          fn(g);
        } catch (e) {
          console.error('[p2p game listener]', e);
        }
      }
    } else if (
      msg.name === 'status' ||
      msg.name === 'peer_disconnected' ||
      msg.name === 'peer_connected' ||
      msg.name === 'peer_reconnected' ||
      msg.name === 'reconnecting' ||
      msg.name === 'channel_open' ||
      msg.name === 'hosting' ||
      msg.name === 'joining' ||
      msg.name === 'discovery_ready' ||
      msg.name === 'swarm_update'
    ) {
      const raw = (msg.data || {}) as Record<string, unknown>;
      const statusName =
        msg.name === 'status' ? String(raw.status || 'status') : msg.name;
      const s: P2PStatusPayload = {
        status: statusName,
        role: (raw.role as P2PRole) || null,
        localSide: (raw.localSide as 'S' | 'N') || null,
        roomCode: (raw.roomCode as string) || null,
        connected:
          statusName === 'peer_connected' ||
          statusName === 'peer_reconnected' ||
          (statusName !== 'peer_disconnected' &&
            statusName !== 'reconnecting' &&
            statusName !== 'channel_open' &&
            Boolean(raw.connected)),
        peers: typeof raw.peers === 'number' ? raw.peers : undefined,
        localPlayerName: (raw.localPlayerName as string) || null,
        remotePlayerName: (raw.remotePlayerName as string) || null,
      };
      if (
        statusName === 'peer_disconnected' ||
        statusName === 'reconnecting' ||
        statusName === 'channel_open'
      ) {
        s.connected = false;
      }
      for (const fn of statusListeners) {
        try {
          fn(s);
        } catch (e) {
          console.error('[p2p status listener]', e);
        }
      }
      // peer_reconnected also wakes match_ready listeners (names + unlock)
      if (statusName === 'peer_reconnected') {
        const m: P2PMatchReadyPayload = {
          roomCode: s.roomCode,
          role: s.role,
          localSide: s.localSide,
          localPlayerName: s.localPlayerName || undefined,
          remotePlayerName: s.remotePlayerName,
        };
        for (const fn of matchReadyListeners) {
          try {
            fn(m);
          } catch (e) {
            console.error('[p2p match_ready listener]', e);
          }
        }
      }
    } else if (
      msg.name === 'match_ready' ||
      msg.name === 'welcomed'
    ) {
      // peer_hello is host-only noise before WELCOME/STATE — do not open the match
      const raw = (msg.data || {}) as Record<string, unknown>;
      const m: P2PMatchReadyPayload = {
        roomCode: (raw.roomCode as string) || null,
        role: (raw.role as P2PRole) || null,
        localSide: (raw.localSide as 'S' | 'N') || (raw.side as 'S' | 'N') || null,
        localPlayerName:
          (raw.localPlayerName as string) ||
          (raw.guestName as string) ||
          undefined,
        remotePlayerName:
          (raw.remotePlayerName as string) ||
          (raw.hostName as string) ||
          (raw.playerName as string) ||
          null,
      };
      for (const fn of matchReadyListeners) {
        try {
          fn(m);
        } catch (e) {
          console.error('[p2p match_ready listener]', e);
        }
      }
    } else if (msg.name === 'peer_hello') {
      // Host: early name of joining guest — status only, do not open board
      const raw = (msg.data || {}) as Record<string, unknown>;
      const guest = (raw.playerName as string) || (raw.remotePlayerName as string) || null;
      if (guest) {
        for (const fn of statusListeners) {
          try {
            fn({
              status: 'peer_hello',
              connected: false,
              remotePlayerName: guest,
              roomCode: (raw.roomCode as string) || null,
              role: (raw.role as P2PRole) || 'host',
            });
          } catch (e) {
            console.error('[p2p status listener]', e);
          }
        }
      }
    } else if (msg.name === 'error') {
      const m = (msg.data as { message?: string })?.message || 'P2P error';
      for (const fn of errorListeners) fn(m);
    } else if (msg.name === 'reject') {
      const r = msg.data as { detail?: string; reason?: string };
      const text = r?.detail || r?.reason || 'rejected';
      for (const fn of rejectListeners) fn(text);
    }
  }
}

function detachWorkerListeners() {
  unsubIpc?.();
  unsubStderr?.();
  unsubExit?.();
  unsubIpc = null;
  unsubStderr = null;
  unsubExit = null;
}

export async function ensureP2PWorker(): Promise<void> {
  const bridge = getBridge();
  if (started) return;
  if (starting) return starting;

  starting = (async () => {
    detachWorkerListeners();
    unsubIpc = bridge.onWorkerIPC(WORKER, (data) => {
      handleIpcRaw(decode(data));
    });
    unsubStderr = bridge.onWorkerStderr?.(WORKER, (data) => {
      console.error('[pear worker]', decode(data));
    }) ?? null;
    unsubExit =
      bridge.onWorkerExit?.(WORKER, () => {
        started = false;
        starting = null;
        clearAllPending(new Error('P2P worker exited'));
        for (const fn of errorListeners) fn('P2P worker exited');
      }) ?? null;

    await bridge.startWorker(WORKER);
    // Wait briefly for ready event path; multiplayer works even if OTA is off
    await new Promise((r) => setTimeout(r, 80));
    started = true;
  })().finally(() => {
    starting = null;
  });

  return starting;
}

function callWorker<T>(op: string, payload?: unknown, timeoutMs = 20_000): Promise<T> {
  const bridge = getBridge();
  if (pending.size >= MAX_PENDING) {
    return Promise.reject(new Error('P2P too many pending requests'));
  }
  const id = ++reqId;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`P2P timeout: ${op}`));
    }, timeoutMs);
    pending.set(id, {
      resolve: (v) => resolve(v as T),
      reject,
      timer,
    });
    const msg = JSON.stringify({ type: 'cmd', id, op, payload: payload ?? null });
    bridge.writeWorkerIPC(WORKER, msg).catch((err) => {
      pending.delete(id);
      clearTimeout(timer);
      reject(err instanceof Error ? err : new Error(String(err)));
    });
  });
}

export function onP2PGame(fn: (g: P2PGamePayload) => void): () => void {
  gameListeners.add(fn);
  return () => gameListeners.delete(fn);
}

export function onP2PStatus(fn: (s: P2PStatusPayload) => void): () => void {
  statusListeners.add(fn);
  return () => statusListeners.delete(fn);
}

export function onP2PMatchReady(fn: (m: P2PMatchReadyPayload) => void): () => void {
  matchReadyListeners.add(fn);
  return () => matchReadyListeners.delete(fn);
}

export function onP2PError(fn: (message: string) => void): () => void {
  errorListeners.add(fn);
  return () => errorListeners.delete(fn);
}

export function onP2PReject(fn: (reason: string) => void): () => void {
  rejectListeners.add(fn);
  return () => rejectListeners.delete(fn);
}

export async function p2pHost(opts?: {
  seeds?: number;
  directionMode?: string;
  firstPlayer?: string;
  multiRound?: boolean;
  residual?: string;
  playerName?: string;
}): Promise<{ roomCode: string; topic?: string; localPlayerName?: string }> {
  await ensureP2PWorker();
  return callWorker('host', opts || {});
}

export async function p2pJoin(
  code: string,
  playerName?: string,
): Promise<{ roomCode: string; topic?: string; localPlayerName?: string }> {
  await ensureP2PWorker();
  return callWorker('join', { code, playerName });
}

export async function p2pPlay(action: {
  type: 'move' | 'pass' | 'resign';
  move?: { startPit: number; direction: 'cw' | 'ccw' };
}): Promise<{
  ok: boolean;
  pending?: boolean;
  seq?: number;
  state?: unknown;
  events?: unknown[];
  error?: string;
  detail?: string;
}> {
  await ensureP2PWorker();
  return callWorker('play', action, 15_000);
}

export async function p2pSnapshot(): Promise<P2PGamePayload> {
  await ensureP2PWorker();
  return callWorker('snapshot');
}

export async function p2pDestroy(): Promise<void> {
  if (!isPearDesktop() || !started) return;
  try {
    await callWorker('destroy', undefined, 5_000);
  } catch {
    /* ignore */
  }
  clearAllPending(new Error('P2P session destroyed'));
}

/** Mid-match reconnect — does not wipe game state (unlike join). */
export async function p2pReconnect(): Promise<{
  ok: boolean;
  role?: string;
  roomCode?: string;
  localPlayerName?: string;
  peerLinked?: boolean;
  error?: string;
}> {
  if (!isPearDesktop()) return { ok: false, error: 'not_desktop' };
  await ensureP2PWorker();
  return callWorker('reconnect', undefined, 30_000);
}

/** Drop bridge listeners (e.g. full app teardown). Worker may stay warm. */
export function resetP2PBridgeListeners(): void {
  gameListeners.clear();
  statusListeners.clear();
  matchReadyListeners.clear();
  errorListeners.clear();
  rejectListeners.clear();
  clearAllPending(new Error('P2P listeners reset'));
}
