/**
 * Shared wire protocol helpers for Chennamane multiplayer.
 * Used by browser PeerJS path; keep in sync with pear-desktop/workers/protocol.js.
 */
import {
  mergeConfig,
  type GameState,
  type Move,
  type MoveEvent,
} from '../../engine';

export const PROTOCOL_VERSION = 1;
export const APP_ID_WEB = 'chennamane-web-v1';
export const APP_ID_PEAR = 'chennamane-pear-v1';
export const MAX_WIRE_EVENTS = 200;
export const MAX_WIRE_JSON_CHARS = 256 * 1024;
export const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export const Msg = {
  HELLO: 'hello',
  WELCOME: 'welcome',
  STATE: 'state',
  MOVE: 'move',
  PASS: 'pass',
  RESIGN: 'resign',
  REJECT: 'reject',
  PING: 'ping',
  PONG: 'pong',
  GOODBYE: 'goodbye',
} as const;

/** How often we ping the peer over the data channel. */
export const HEARTBEAT_INTERVAL_MS = 2_500;
/** No pong within this window → treat as disconnected (tab close, crash, network). */
export const HEARTBEAT_TIMEOUT_MS = 7_500;

export type WireMsg = {
  v?: number;
  app?: string;
  type: string;
  [key: string]: unknown;
};

export function sanitizePlayerName(n: unknown): string {
  const t = String(n || '')
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, 24);
  return t || 'Player';
}

export function generateRoomCode(len = 6): string {
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  let out = '';
  for (let i = 0; i < len; i++) {
    out += CODE_ALPHABET[bytes[i]! % CODE_ALPHABET.length]!;
  }
  return out;
}

export function normalizeRoomCode(code: string): string {
  return String(code || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

/** Deterministic PeerJS host id — room code remains the human invite. */
export function peerIdFromRoom(code: string): string {
  return `agm-${normalizeRoomCode(code).toLowerCase()}`;
}

export function capEvents(events: MoveEvent[] | null | undefined): MoveEvent[] {
  if (!events?.length) return [];
  if (events.length <= MAX_WIRE_EVENTS) return events;
  return [];
}

export function slimConfig(config: GameState['config']): GameState['config'] {
  return mergeConfig({
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
    customLayout: config.customLayout,
  });
}

export function isValidGameState(state: unknown): state is GameState {
  if (!state || typeof state !== 'object') return false;
  const s = state as GameState;
  if (!Array.isArray(s.pits) || s.pits.length !== 14) return false;
  if (!s.score || typeof s.score.S !== 'number' || typeof s.score.N !== 'number') return false;
  if (s.toMove !== 'S' && s.toMove !== 'N') return false;
  for (let i = 0; i < 14; i++) {
    const n = s.pits[i];
    if (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > 500) return false;
  }
  if (
    s.protectedMask &&
    (!Array.isArray(s.protectedMask) || s.protectedMask.length !== 14)
  ) {
    return false;
  }
  return true;
}

export function isMoveIntent(msg: WireMsg): msg is WireMsg & { move: Move } {
  const move = msg.move;
  if (!move || typeof move !== 'object') return false;
  const m = move as Move;
  return (
    msg.type === Msg.MOVE &&
    typeof m.startPit === 'number' &&
    Number.isInteger(m.startPit) &&
    m.startPit >= 0 &&
    m.startPit <= 13 &&
    (m.direction === 'cw' || m.direction === 'ccw')
  );
}

export function isPassIntent(msg: WireMsg): boolean {
  return msg.type === Msg.PASS;
}

export function isResignIntent(msg: WireMsg): boolean {
  return msg.type === Msg.RESIGN;
}

export function encodeWire(msg: WireMsg, appId: string = APP_ID_WEB): WireMsg {
  return { v: PROTOCOL_VERSION, app: appId, ...msg };
}

export function parseWire(raw: unknown): { ok: true; msg: WireMsg } | { ok: false; error: string } {
  if (raw == null) return { ok: false, error: 'empty' };
  if (typeof raw === 'string') {
    if (raw.length > MAX_WIRE_JSON_CHARS) return { ok: false, error: 'payload_too_large' };
    try {
      raw = JSON.parse(raw);
    } catch {
      return { ok: false, error: 'invalid_json' };
    }
  }
  if (typeof raw !== 'object') return { ok: false, error: 'missing_type' };
  const msg = raw as WireMsg;
  if (typeof msg.type !== 'string') return { ok: false, error: 'missing_type' };
  if (msg.v != null && msg.v !== PROTOCOL_VERSION) {
    return { ok: false, error: 'version_mismatch' };
  }
  return { ok: true, msg };
}

export function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === 'object') {
    const o = err as { message?: string; type?: string };
    if (o.message) return o.message;
    if (o.type) return String(o.type);
  }
  return String(err);
}
