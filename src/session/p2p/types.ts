import type { Direction, GameState, MoveEvent } from '../../engine';

export type P2PRole = 'host' | 'guest';
export type P2PTransportKind = 'pear' | 'web';

export type P2PGamePayload = {
  state: GameState | null;
  seq: number;
  localSide: 'S' | 'N' | null;
  role: P2PRole | null;
  roomCode?: string | null;
  connected?: boolean;
  terminal: boolean;
  winner: string | null;
  legal: { startPit: number; direction: Direction }[];
  yourTurn: boolean;
  events?: MoveEvent[] | null;
  reason?: string | null;
  localPlayerName?: string | null;
  remotePlayerName?: string | null;
  matchReady?: boolean;
};

export type P2PStatusPayload = {
  status: string;
  role?: P2PRole | null;
  localSide?: 'S' | 'N' | null;
  roomCode?: string | null;
  connected?: boolean;
  peers?: number;
  localPlayerName?: string | null;
  remotePlayerName?: string | null;
};

export type P2PMatchReadyPayload = {
  localPlayerName?: string;
  remotePlayerName?: string | null;
  roomCode?: string | null;
  role?: P2PRole | null;
  localSide?: 'S' | 'N' | null;
};

export type P2PPlayAction = {
  type: 'move' | 'pass' | 'resign';
  move?: { startPit: number; direction: Direction };
};

export type P2PPlayResult = {
  ok: boolean;
  pending?: boolean;
  seq?: number;
  state?: GameState;
  events?: MoveEvent[];
  error?: string;
  detail?: string;
};

export type P2PHostOptions = {
  seeds?: number;
  directionMode?: string;
  multiRound?: boolean;
  residual?: string;
  firstPlayer?: string;
  playerName?: string;
};

export type P2PJoinResult = {
  roomCode: string;
  localPlayerName: string;
  /** True when a peer data channel/socket is already open. */
  peerLinked: boolean;
};

export type P2PHostResult = {
  roomCode: string;
  localPlayerName: string;
  peerLinked: boolean;
};
