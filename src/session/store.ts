import { create } from 'zustand';
import {
  applyMove,
  applyPass,
  createGame,
  defaultPreviewDirection,
  getLegalMoves,
  INDEX_TO_LABEL,
  isTerminal,
  mergeConfig,
  needsSecondSowing,
  ownedPits,
  previewMoveConsequences,
  resign as engineResign,
  type GameState,
  type MatchEndReason,
  type Move,
  type MoveEvent,
  type PitIndex,
  type PlayerId,
} from '../engine';
import { search, type Difficulty } from '../ai';
import { sfx, setSoundEnabled } from '../audio/sfx';
import {
  dropMsForSpeed,
  eventPaceFromDrop,
  prefersReducedMotion,
  shouldBatchSow,
} from './animationPace';
import { DEFAULT_SETTINGS, loadSettings, saveSettings, type Settings } from './settings';
import {
  matchOutcome,
  outcomeStatusDetail,
  playerLabel,
  type GameMode,
} from './outcome';
import {
  isP2PAvailable,
  isValidGameState,
  onP2PError,
  onP2PGame,
  onP2PMatchReady,
  onP2PReject,
  onP2PStatus,
  p2pDestroy,
  p2pHost,
  p2pJoin,
  p2pPlay,
  p2pReconnect,
  p2pSnapshot,
  sanitizePlayerName,
  type P2PGamePayload,
} from './p2p';

export type Screen = 'home' | 'game' | 'rules' | 'settings' | 'coach';
export type { GameMode };
export type P2PLobbyStatus =
  | 'idle'
  | 'connecting'
  | 'hosting'
  | 'joining'
  | 'error';
export type TurnPhase =
  | 'your-turn'
  | 'hotseat-turn'
  | 'ai-thinking'
  | 'ai-preview'
  | 'ai-playing'
  | 'animating'
  | 'pass'
  | 'over';

/** Visual cue for the active pit during sowing / capture. */
export type PitHighlightKind =
  | 'none'
  | 'select'
  | 'pickup'
  | 'drop'
  | 'continue'
  | 'saada'
  | 'capture'
  | 'ai';

export interface CaptureFlight {
  id: number;
  /** Store the beads travel to. */
  side: 'S' | 'N';
  pits: { pit: number; amount: number }[];
  /**
   * Store capture-sleep budget (ms) committed when this flight was emitted.
   * Visuals must finish within this — do not recompute from the HUD slider.
   */
  budgetMs: number;
}

let captureFlightSeq = 0;

const HISTORY_CAP = 200;

/** Shared empty board buffers for P2P/open — avoid per-update allocations. */
const EMPTY_PITS14: number[] = Object.freeze(Array(14).fill(0)) as number[];
const EMPTY_PROTECTED14: boolean[] = Object.freeze(Array(14).fill(false)) as boolean[];
const EMPTY_SCORE = Object.freeze({ S: 0, N: 0, E: 0 }) as Record<PlayerId, number>;

const P2P_NAME_KEY = 'chennamane-p2p-player-name';

function loadP2PPlayerName(): string {
  try {
    return sanitizePlayerName(localStorage.getItem(P2P_NAME_KEY));
  } catch {
    return 'Player';
  }
}

function saveP2PPlayerName(name: string) {
  try {
    localStorage.setItem(P2P_NAME_KEY, sanitizePlayerName(name));
  } catch {
    /* ignore */
  }
}

/** Prefer a real nickname over wire defaults / empty echoes. */
function preferPlayerName(
  wire: string | null | undefined,
  current: string | null | undefined,
): string {
  const cur = (current || '').trim();
  if (cur && cur !== 'Player') return cur;
  const w = (wire || '').trim();
  if (w) return w;
  return cur || 'Player';
}

function outcomeMeta(session: {
  mode: GameMode;
  humanPlayer: PlayerId;
  p2pLocalName?: string;
  p2pRemoteName?: string | null;
  lastMatchEndReason?: MatchEndReason | null;
  endReason?: MatchEndReason | null;
}) {
  return {
    mode: session.mode,
    humanPlayer: session.humanPlayer,
    endReason: session.endReason ?? session.lastMatchEndReason ?? null,
    names: {
      local: session.p2pLocalName,
      remote: session.p2pRemoteName,
    },
  };
}

/** Minimum time the "AI is thinking" state stays visible (ms). */
const AI_MIN_THINK_MS: Record<Difficulty, number> = {
  easy: 750,
  medium: 1100,
  hard: 1400,
};

/** Pause after choosing a pit so player sees which pit AI will sow from. */
const AI_PREVIEW_MS = 900;

/** Pause between AI first and second sowing. */
const AI_BETWEEN_SOWINGS_MS = 700;

/** Brief beat after a human move before AI takes over. */
const HANDOFF_TO_AI_MS = 550;

export interface GameSession {
  screen: Screen;
  settings: Settings;
  settingsPersistFailed: boolean;
  mode: GameMode;
  humanPlayer: PlayerId;
  aiDifficulty: Difficulty;
  committed: GameState | null;
  displayPits: number[];
  displayScore: Record<PlayerId, number>;
  /** Protected (out-of-play) pits as currently presented on the board. */
  displayProtected: boolean[];
  /** 0-based round index as currently presented (multi-round series). */
  displayRound: number;
  historyPast: GameState[];
  historyFuture: GameState[];
  inputLocked: boolean;
  thinking: boolean;
  turnPhase: TurnPhase;
  /** Pit about to be sown (AI preview or human selection). */
  highlightPit: PitIndex | null;
  /** Extra pits lit at once (e.g. second capture bowl). */
  highlightPitsExtra: PitIndex[];
  /** How the highlight should animate on the board. */
  highlightKind: PitHighlightKind;
  /** Side that just captured (for coconut shell bounce). */
  lastCaptureSide: PlayerId | null;
  /**
   * One-shot event: captured beads fly from their pits into the capturer's
   * coconut store. Consumers react to `id` changes; stale values are inert.
   */
  captureFlight: CaptureFlight | null;
  /**
   * Drop-base budget (ms) the store committed for the current anim beat.
   * Boards use this for hopDurationMs / hopSettleMs so the HUD slider cannot
   * desync visual flight from the sleep already in progress. 0 = no hop.
   */
  animBudgetMs: number;
  /**
   * Seeds remaining in hand during selection / sowing.
   * `null` when not carrying. Updated on pickup / drop / continue.
   */
  displayHand: number | null;
  /** Direction shown during AI preview. */
  highlightDir: 'cw' | 'ccw' | null;
  selectedPit: PitIndex | null;
  pendingDirection: boolean;
  hintsEnabled: boolean;
  animationGeneration: number;
  lastEvents: MoveEvent[];
  showResult: boolean;
  coachSeen: boolean;
  searchCancelled: boolean;
  statusMessage: string;
  statusDetail: string;
  /** Last matchEnd reason (authoritative for result overlay). */
  lastMatchEndReason: MatchEndReason | null;
  /**
   * Pits highlighted for move preview (saada empty + capture bowls) while
   * a pit is selected / direction chooser is open.
   */
  previewPits: PitIndex[];
  previewKind: 'none' | 'path' | 'saada' | 'capture';

  /** Pear desktop P2P */
  p2pAvailable: boolean;
  p2pRoomCode: string | null;
  p2pConnected: boolean;
  p2pLobbyStatus: P2PLobbyStatus;
  p2pLobbyMessage: string;
  p2pSeq: number;
  /** Local display name for P2P */
  p2pLocalName: string;
  /** Opponent display name once joined */
  p2pRemoteName: string | null;
  /** True while guest auto/manual reconnect is in progress */
  p2pReconnecting: boolean;

  setScreen: (s: Screen) => void;
  updateSettings: (partial: Partial<Settings>) => void;
  newGame: (
    mode: GameMode,
    opts?: {
      difficulty?: Difficulty;
      human?: PlayerId;
    },
  ) => void;
  /** Host a P2P room (South). Stays in lobby until a peer joins. */
  hostP2P: (playerName?: string) => Promise<void>;
  /** Join a P2P room (North). Game opens when host accepts. */
  joinP2P: (code: string, playerName?: string) => Promise<void>;
  leaveP2P: () => Promise<void>;
  /** Rejoin after a drop (guest dials host; host keeps listening). */
  reconnectP2P: () => Promise<void>;
  selectPit: (pit: PitIndex) => void;
  clearSelection: () => void;
  chooseDirection: (dir: 'cw' | 'ccw') => void;
  undo: () => void;
  redo: () => void;
  resign: () => void;
  skipAnimation: () => void;
  toggleHints: () => void;
  resolveLoop: () => void;
  setCoachSeen: () => void;
  dismissResult: () => void;
}

function eventPacing(settings: Settings) {
  return eventPaceFromDrop(
    dropMsForSpeed(settings.travelSpeed, prefersReducedMotion(settings)),
  );
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Await pacing, then confirm this animation generation still owns the board.
 * Skip/undo/newGame bump `animationGeneration` — without this gate, post-sleep
 * mutations (e.g. landing a drop) would overwrite the restored display board.
 */
async function sleepWhileCurrent(ms: number, gen: number): Promise<boolean> {
  if (ms > 0) await sleep(ms);
  return useGameStore.getState().animationGeneration === gen;
}

function dirLabel(dir: 'cw' | 'ccw'): string {
  return dir === 'ccw' ? 'anti-clockwise' : 'clockwise';
}

function humanRowHint(human: PlayerId): string {
  return human === 'S'
    ? 'Legal pits are on South (near row).'
    : 'Legal pits are on North (far row).';
}

function aiRowHint(human: PlayerId): string {
  return human === 'S'
    ? 'AI plays North (far row).'
    : 'AI plays South (near row).';
}

/**
 * Single terminal presentation transition: show result, phase over, status, optional SFX.
 */
function enterMatchOver(
  state: GameState,
  opts: {
    playSfx?: boolean;
    mode: GameMode;
    humanPlayer: PlayerId;
    endReason?: MatchEndReason | null;
  },
): void {
  const cur = useGameStore.getState();
  const endReason = opts.endReason ?? cur.lastMatchEndReason ?? null;
  const outcome = matchOutcome(
    state,
    outcomeMeta({
      mode: opts.mode,
      humanPlayer: opts.humanPlayer,
      endReason,
      p2pLocalName: cur.p2pLocalName,
      p2pRemoteName: cur.p2pRemoteName,
    }),
  );
  if (outcome.kind === 'ongoing') return;

  // Single place for the outcome sting. Skip / resolve / anim-end may all call
  // this; only the first transition into 'over' may play SFX.
  const alreadyOver = useGameStore.getState().turnPhase === 'over';
  if (opts.playSfx !== false && !alreadyOver) {
    const human = opts.mode === 'ai' ? opts.humanPlayer : null;
    const winner =
      outcome.kind === 'draw' ? 'draw' : outcome.winner;
    sfx.matchOutcome(winner, human);
  }

  useGameStore.setState({
    displayPits: state.pits.slice(),
    displayScore: { S: state.score.S, N: state.score.N, E: state.score.E ?? 0 },
    displayProtected: state.protectedMask.slice(),
    displayRound: state.roundIndex,
    showResult: true,
    turnPhase: 'over',
    inputLocked: false,
    thinking: false,
    // Drop in-progress selection so the direction sheet cannot sit on top of results
    selectedPit: null,
    pendingDirection: false,
    highlightPit: null,
    highlightPitsExtra: [],
    highlightKind: 'none',
    highlightDir: null,
    displayHand: null,
    captureFlight: null,
    animBudgetMs: 0,
    lastCaptureSide: null,
    lastMatchEndReason: endReason ?? outcome.endReason,
    previewPits: [],
    previewKind: 'none',
    statusMessage: 'Game over',
    statusDetail: outcomeStatusDetail(outcome),
  });
}

function setMovePreview(state: GameState, pit: PitIndex, dir: 'cw' | 'ccw') {
  const prev = previewMoveConsequences(state, { startPit: pit, direction: dir });
  if (!prev) {
    useGameStore.setState({ previewPits: [], previewKind: 'none' });
    return;
  }
  const pits: PitIndex[] = [];
  if (prev.saadaEmpty !== null) pits.push(prev.saadaEmpty);
  for (const p of prev.capturePits) pits.push(p);
  useGameStore.setState({
    previewPits: pits,
    previewKind:
      prev.capturePits.length > 0
        ? 'capture'
        : prev.saadaEmpty !== null
          ? 'saada'
          : 'path',
  });
}

export const useGameStore = create<GameSession>((set, get) => ({
  screen: 'home',
  settings: loadSettings(),
  settingsPersistFailed: false,
  mode: 'ai',
  humanPlayer: 'S',
  aiDifficulty: 'easy',
  committed: null,
  displayPits: Array(14).fill(0),
  displayScore: { S: 0, N: 0, E: 0 },
  displayProtected: Array(14).fill(false),
  displayRound: 0,
  historyPast: [],
  historyFuture: [],
  inputLocked: false,
  thinking: false,
  turnPhase: 'your-turn',
  highlightPit: null,
  highlightPitsExtra: [],
  highlightKind: 'none',
  lastCaptureSide: null,
  captureFlight: null,
  animBudgetMs: 0,
  displayHand: null,
  highlightDir: null,
  selectedPit: null,
  pendingDirection: false,
  hintsEnabled: false,
  animationGeneration: 0,
  lastEvents: [],
  showResult: false,
  coachSeen: false,
  searchCancelled: false,
  statusMessage: '',
  statusDetail: '',
  lastMatchEndReason: null,
  previewPits: [],
  previewKind: 'none',
  p2pAvailable: typeof window !== 'undefined' && isP2PAvailable(),
  p2pRoomCode: null,
  p2pConnected: false,
  p2pLobbyStatus: 'idle',
  p2pLobbyMessage: '',
  p2pSeq: 0,
  p2pLocalName: loadP2PPlayerName(),
  p2pRemoteName: null,
  p2pReconnecting: false,

  setScreen: (screen) => {
    // Leaving the game mid-anim/AI must cancel resolve loops so they don't
    // keep mutating state while the user is on home/rules/settings.
    if (screen !== 'game' && get().screen === 'game') {
      abortAnim();
      const wasP2p = get().mode === 'p2p';
      if (wasP2p) {
        p2pQueue.length = 0;
        clearP2PPendingTimeouts();
        void p2pDestroy();
      }
      set({
        screen,
        // Reset mode so home lobby is not stuck in a half-dead p2p session
        mode: wasP2p ? 'ai' : get().mode,
        committed: wasP2p ? null : get().committed,
        thinking: false,
        inputLocked: false,
        pendingDirection: false,
        selectedPit: null,
        displayHand: null,
        captureFlight: null,
        animBudgetMs: 0,
        highlightPit: null,
        highlightPitsExtra: [],
        highlightKind: 'none',
        highlightDir: null,
        lastEvents: wasP2p ? [] : get().lastEvents,
        historyPast: wasP2p ? [] : get().historyPast,
        historyFuture: wasP2p ? [] : get().historyFuture,
        showResult: false,
        p2pRoomCode: null,
        p2pConnected: false,
        p2pLobbyStatus: 'idle',
        p2pLobbyMessage: '',
        p2pSeq: 0,
        p2pRemoteName: null,
      });
      return;
    }
    set({ screen });
  },

  updateSettings: (partial) => {
    const settings = { ...get().settings, ...partial };
    const ok = saveSettings(settings);
    setSoundEnabled(settings.soundEnabled);
    set({ settings, settingsPersistFailed: !ok });
  },

  newGame: (mode, opts) => {
    const { settings } = get();
    setSoundEnabled(settings.soundEnabled);
    // Kill any in-flight anim/AI from the previous match before opening a new one.
    abortAnim();
    const gen = get().animationGeneration + 1;
    const human = opts?.human ?? 'S';
    const difficulty = opts?.difficulty ?? get().aiDifficulty;

    // Product surface: Ali Guli Mane only (+ seed/direction/series/residual).
    const engineConfig = mergeConfig({
      initialSeedsPerPit: settings.initialSeedsPerPit,
      directionMode: settings.directionMode,
      matchStructure: settings.multiRound ? 'multi-round-protected' : 'single',
      residual: settings.residual,
      secondSowing: 'forced',
      engineFamily: 'bule-perga',
      playerCount: 2,
    });

    const firstPlayer: PlayerId =
      mode === 'ai' ? human : Math.random() < 0.5 ? 'S' : 'N';

    const committed = createGame(engineConfig, { firstPlayer });

    const youToMove = mode === 'ai' && committed.toMove === human;
    const phase: TurnPhase =
      mode === 'ai' ? (youToMove ? 'your-turn' : 'ai-thinking') : 'hotseat-turn';

    set({
      screen: 'game',
      mode,
      humanPlayer: human,
      aiDifficulty: difficulty,
      committed,
      displayPits: committed.pits.slice(),
      displayScore: {
        S: committed.score.S,
        N: committed.score.N,
        E: committed.score.E ?? 0,
      },
      displayProtected: committed.protectedMask.slice(),
      displayRound: committed.roundIndex,
      historyPast: [],
      historyFuture: [],
      inputLocked: false,
      thinking: false,
      turnPhase: phase,
      highlightPit: null,
      highlightPitsExtra: [],
      highlightKind: 'none',
      highlightDir: null,
      displayHand: null,
      captureFlight: null,
      animBudgetMs: 0,
      lastCaptureSide: null,
      selectedPit: null,
      pendingDirection: false,
      hintsEnabled: settings.hintsDefault,
      animationGeneration: gen,
      lastEvents: [],
      showResult: false,
      lastMatchEndReason: null,
      previewPits: [],
      previewKind: 'none',
      // Fresh game may need AI search; prior in-flight search was cancelled by abortAnim.
      searchCancelled: false,
      statusMessage: youToMove
        ? 'Your turn'
        : mode === 'ai'
          ? "AI's turn"
          : `${committed.toMove === 'S' ? 'South' : 'North'} to move`,
      statusDetail: youToMove
        ? 'Tap a legal pit on your row.'
        : mode === 'ai'
          ? aiRowHint(human)
          : 'Pick a pit on your row.',
    });
    queueMicrotask(() => get().resolveLoop());
  },

  hostP2P: async (playerName) => {
    if (!isP2PAvailable()) {
      set({
        p2pLobbyStatus: 'error',
        p2pLobbyMessage: 'Online multiplayer needs a modern browser (WebRTC) or the desktop app.',
      });
      return;
    }
    // Synchronous guard — React state updates are async; blocks double-click races
    if (
      get().p2pLobbyStatus === 'connecting' ||
      get().p2pLobbyStatus === 'hosting' ||
      p2pLobbyOpInFlight
    ) {
      return;
    }
    p2pLobbyOpInFlight = true;
    ensureP2PSubscriptions();
    const { settings } = get();
    const name = sanitizePlayerName(playerName ?? get().p2pLocalName);
    saveP2PPlayerName(name);
    setSoundEnabled(settings.soundEnabled);
    abortAnim();
    p2pQueue.length = 0;
    clearP2PPendingTimeouts();
    try {
      await p2pDestroy();
    } catch {
      /* ignore */
    }
    set({
      p2pLobbyStatus: 'connecting',
      p2pLobbyMessage: 'Creating room…',
      p2pConnected: false,
      p2pSeq: 0,
      p2pRoomCode: null,
      p2pLocalName: name,
      p2pRemoteName: null,
      screen: 'home',
      mode: 'ai',
      committed: null,
    });
    try {
      const res = await p2pHost({
        seeds: settings.initialSeedsPerPit,
        directionMode: settings.directionMode,
        firstPlayer: 'S',
        multiRound: settings.multiRound,
        residual: settings.residual,
        playerName: name,
      });
      // Stay on home until a peer joins — do not open the board yet
      set({
        p2pLobbyStatus: 'hosting',
        p2pLobbyMessage: `Room ${res.roomCode} — waiting for opponent…`,
        p2pRoomCode: res.roomCode,
        p2pLocalName: res.localPlayerName || name,
        p2pRemoteName: null,
        p2pConnected: false,
        p2pSeq: 0,
        humanPlayer: 'S',
      });
    } catch (err) {
      set({
        p2pLobbyStatus: 'error',
        p2pLobbyMessage: err instanceof Error ? err.message : String(err),
      });
    } finally {
      p2pLobbyOpInFlight = false;
    }
  },

  joinP2P: async (code, playerName) => {
    if (!isP2PAvailable()) {
      set({
        p2pLobbyStatus: 'error',
        p2pLobbyMessage: 'Online multiplayer needs a modern browser (WebRTC) or the desktop app.',
      });
      return;
    }
    if (
      get().p2pLobbyStatus === 'connecting' ||
      get().p2pLobbyStatus === 'joining' ||
      p2pLobbyOpInFlight
    ) {
      return;
    }
    p2pLobbyOpInFlight = true;
    ensureP2PSubscriptions();
    const trimmed = code.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (trimmed.length < 4) {
      p2pLobbyOpInFlight = false;
      set({
        p2pLobbyStatus: 'error',
        p2pLobbyMessage: 'Enter a valid room code (4+ characters).',
      });
      return;
    }
    const name = sanitizePlayerName(playerName ?? get().p2pLocalName);
    saveP2PPlayerName(name);
    const { settings } = get();
    setSoundEnabled(settings.soundEnabled);
    abortAnim();
    p2pQueue.length = 0;
    clearP2PPendingTimeouts();
    try {
      await p2pDestroy();
    } catch {
      /* ignore */
    }
    set({
      p2pLobbyStatus: 'connecting',
      p2pLobbyMessage: 'Joining…',
      p2pConnected: false,
      p2pSeq: 0,
      p2pRoomCode: null,
      p2pLocalName: name,
      p2pRemoteName: null,
      screen: 'home',
      mode: 'ai',
      committed: null,
    });
    try {
      const res = await p2pJoin(trimmed, name);
      // peerLinked is set by the transport (WebRTC waits for channel; Pear does not).
      set({
        p2pLobbyStatus: 'joining',
        p2pLobbyMessage: res.peerLinked
          ? `Joined ${res.roomCode} — syncing with host…`
          : `Joined ${res.roomCode} — looking for host…`,
        p2pRoomCode: res.roomCode,
        p2pLocalName: res.localPlayerName || name,
        p2pRemoteName: null,
        p2pConnected: res.peerLinked,
        p2pSeq: 0,
        humanPlayer: 'N',
      });
    } catch (err) {
      set({
        p2pLobbyStatus: 'error',
        p2pLobbyMessage: err instanceof Error ? err.message : String(err),
      });
    } finally {
      p2pLobbyOpInFlight = false;
    }
  },

  leaveP2P: async () => {
    abortAnim();
    p2pQueue.length = 0;
    clearP2PPendingTimeouts();
    try {
      await p2pDestroy();
    } catch {
      /* ignore */
    }
    set({
      screen: 'home',
      mode: 'ai',
      committed: null,
      displayPits: EMPTY_PITS14,
      displayScore: EMPTY_SCORE,
      displayProtected: EMPTY_PROTECTED14,
      historyPast: [],
      historyFuture: [],
      lastEvents: [],
      captureFlight: null,
      animBudgetMs: 0,
      previewPits: [],
      previewKind: 'none',
      p2pRoomCode: null,
      p2pConnected: false,
      p2pLobbyStatus: 'idle',
      p2pLobbyMessage: '',
      p2pSeq: 0,
      p2pRemoteName: null,
      p2pReconnecting: false,
      inputLocked: false,
      thinking: false,
      showResult: false,
      selectedPit: null,
      pendingDirection: false,
    });
  },

  reconnectP2P: async () => {
    const cur = get();
    if (cur.mode !== 'p2p' && cur.p2pLobbyStatus === 'idle') return;
    if (cur.p2pConnected) return;
    if (p2pReconnectOpInFlight) return;
    // Host only re-binds signaling; guest redials
    if (cur.humanPlayer === 'S' && cur.p2pLobbyStatus !== 'joining') {
      set({
        statusMessage: 'Opponent disconnected',
        statusDetail: cur.p2pRoomCode
          ? `Room ${cur.p2pRoomCode} — waiting for ${cur.p2pRemoteName || 'opponent'} to rejoin…`
          : 'Waiting for opponent to rejoin…',
        inputLocked: true,
        p2pReconnecting: false,
      });
      try {
        await p2pReconnect({
          code: cur.p2pRoomCode || undefined,
          playerName: cur.p2pLocalName,
        });
      } catch {
        /* host wait is passive */
      }
      return;
    }
    p2pReconnectOpInFlight = true;
    set({
      p2pReconnecting: true,
      statusMessage: 'Reconnecting…',
      statusDetail: cur.p2pRoomCode
        ? `Room ${cur.p2pRoomCode} — trying to reach ${cur.p2pRemoteName || 'opponent'}…`
        : 'Trying to reconnect…',
      inputLocked: true,
    });
    try {
      const res = await p2pReconnect({
        code: cur.p2pRoomCode || undefined,
        playerName: cur.p2pLocalName,
      });
      if (!res.ok) {
        set({
          p2pReconnecting: false,
          statusMessage: 'Disconnected',
          statusDetail: res.error || 'Reconnect failed. Try again or leave the room.',
          inputLocked: true,
        });
        return;
      }
      // Guest: peer_reconnected / STATE clears p2pReconnecting
    } catch (err) {
      set({
        p2pReconnecting: false,
        statusMessage: 'Disconnected',
        statusDetail: err instanceof Error ? err.message : String(err),
        inputLocked: true,
      });
    } finally {
      p2pReconnectOpInFlight = false;
    }
  },

  selectPit: (pit) => {
    const { committed, inputLocked, mode, humanPlayer, thinking } = get();
    if (!committed || inputLocked || thinking || humanMoveInFlight || isTerminal(committed))
      return;
    if ((mode === 'ai' || mode === 'p2p') && committed.toMove !== humanPlayer) {
      set({
        statusDetail:
          mode === 'p2p' ? "Wait for your opponent's turn." : "Wait for the AI's turn to finish.",
      });
      return;
    }
    const legal = getLegalMoves(committed);
    if (!legal.some((m) => m.startPit === pit)) {
      // Referee feedback — don't fail silently
      const own = ownedPits(committed.toMove, committed.config);
      let detail = 'That pit is not a legal start.';
      if (!own.includes(pit)) {
        detail = 'Not your row — pick a pit on your side.';
      } else if ((committed.pits[pit] ?? 0) <= 0) {
        detail = 'That pit is empty.';
      } else if (committed.protectedMask[pit]) {
        detail = 'That pit is closed for this round.';
      } else if (needsSecondSowing(committed)) {
        detail = 'Second sowing: pick a legal pit on your row.';
      }
      set({
        statusMessage: statusHeadline(committed, get()),
        statusDetail: detail,
        previewPits: [],
        previewKind: 'none',
      });
      return;
    }

    // Use committed pits (source of truth), not display mid-animation.
    const hand = committed.pits[pit] ?? 0;
    const dirMode = committed.config.directionMode;
    sfx.select(pit);
    if (dirMode === 'fixedCcw') {
      void playHumanMove({ startPit: pit, direction: 'ccw' });
      return;
    }
    if (dirMode === 'fixedCw') {
      void playHumanMove({ startPit: pit, direction: 'cw' });
      return;
    }
    const previewDir = defaultPreviewDirection(committed);
    set({
      selectedPit: pit,
      pendingDirection: true,
      highlightPit: pit,
      highlightPitsExtra: [],
      highlightKind: 'select',
      displayHand: hand > 0 ? hand : null,
      statusMessage: needsSecondSowing(committed)
        ? 'Second sowing — choose direction'
        : 'Choose direction',
      statusDetail: `${INDEX_TO_LABEL[pit] ?? pit} · ${hand} remaining.`,
    });
    setMovePreview(committed, pit, previewDir);
  },

  clearSelection: () => {
    const s = get();
    const committed = s.committed;
    set({
      selectedPit: null,
      pendingDirection: false,
      highlightPit: null,
      highlightPitsExtra: [],
      highlightKind: 'none',
      animBudgetMs: 0,
      displayHand: null,
      previewPits: [],
      previewKind: 'none',
      statusMessage: committed
        ? statusHeadline(committed, s)
        : 'Your turn',
      statusDetail: committed
        ? statusDetailFor(committed, s)
        : 'Tap a legal pit on your row.',
    });
  },

  chooseDirection: (dir) => {
    const { selectedPit, inputLocked, thinking, committed } = get();
    if (selectedPit === null || inputLocked || thinking || humanMoveInFlight) return;
    if (!committed || isTerminal(committed)) return;
    const pit = selectedPit;
    // Clear chooser first; playHumanMove claims the input lock immediately.
    set({
      selectedPit: null,
      pendingDirection: false,
      previewPits: [],
      previewKind: 'none',
    });
    void playHumanMove({ startPit: pit, direction: dir });
  },

  undo: () => {
    const s = get();
    if (s.mode === 'p2p') return;
    if (s.historyPast.length === 0 || !s.committed) return;
    abortAnim();
    const past = [...s.historyPast];
    const future = [s.committed, ...s.historyFuture];
    let current = past.pop()!;

    while (
      past.length > 0 &&
      s.mode === 'ai' &&
      !isTerminal(current) &&
      current.toMove !== s.humanPlayer
    ) {
      future.unshift(current);
      current = past.pop()!;
    }

    const you = s.mode === 'ai' && current.toMove === s.humanPlayer;
    set({
      committed: current,
      displayPits: current.pits.slice(),
      displayScore: {
        S: current.score.S,
        N: current.score.N,
        E: current.score.E ?? 0,
      },
      displayProtected: current.protectedMask.slice(),
      displayRound: current.roundIndex,
      historyPast: past,
      historyFuture: future.slice(0, HISTORY_CAP),
      inputLocked: false,
      thinking: false,
      turnPhase: phaseAfterState(current, s),
      searchCancelled: true,
      selectedPit: null,
      pendingDirection: false,
      highlightPit: null,
      highlightPitsExtra: [],
      highlightKind: 'none',
      highlightDir: null,
      displayHand: null,
      captureFlight: null,
      animBudgetMs: 0,
      lastCaptureSide: null,
      showResult: isTerminal(current),
      statusMessage: isTerminal(current) ? 'Game over' : 'Undid move',
      statusDetail: isTerminal(current)
        ? outcomeStatusDetail(matchOutcome(current, outcomeMeta(s)))
        : you
          ? 'Your turn again.'
          : s.mode === 'hotseat'
            ? `${current.toMove === 'S' ? 'South' : 'North'} to move.`
            : statusDetailFor(current, s),
    });
    queueMicrotask(() => get().resolveLoop());
  },

  redo: () => {
    const s = get();
    if (s.mode === 'p2p') return;
    if (s.historyFuture.length === 0) return;
    abortAnim();
    const future = [...s.historyFuture];
    const past = s.committed ? [...s.historyPast, s.committed] : [...s.historyPast];
    let current = future.shift()!;

    // Mirror undo: skip AI-to-move checkpoints so redo restores the post-AI
    // human position instead of re-searching and wiping historyFuture.
    while (
      future.length > 0 &&
      s.mode === 'ai' &&
      !isTerminal(current) &&
      current.toMove !== s.humanPlayer
    ) {
      past.push(current);
      current = future.shift()!;
    }

    const you = s.mode === 'ai' && current.toMove === s.humanPlayer;
    set({
      committed: current,
      displayPits: current.pits.slice(),
      displayScore: {
        S: current.score.S,
        N: current.score.N,
        E: current.score.E ?? 0,
      },
      displayProtected: current.protectedMask.slice(),
      displayRound: current.roundIndex,
      historyPast: past.slice(-HISTORY_CAP),
      historyFuture: future,
      inputLocked: false,
      thinking: false,
      searchCancelled: true,
      selectedPit: null,
      pendingDirection: false,
      highlightPit: null,
      highlightPitsExtra: [],
      highlightKind: 'none',
      highlightDir: null,
      displayHand: null,
      captureFlight: null,
      animBudgetMs: 0,
      lastCaptureSide: null,
      showResult: isTerminal(current),
      turnPhase: phaseAfterState(current, s),
      statusMessage: isTerminal(current) ? 'Game over' : 'Redid move',
      statusDetail: isTerminal(current)
        ? outcomeStatusDetail(matchOutcome(current, outcomeMeta(s)))
        : you
          ? 'Your turn again.'
          : s.mode === 'hotseat'
            ? `${current.toMove === 'S' ? 'South' : 'North'} to move.`
            : statusDetailFor(current, s),
    });
    queueMicrotask(() => get().resolveLoop());
  },

  resign: () => {
    const s = get();
    if (!s.committed || isTerminal(s.committed)) return;
    if (s.mode === 'p2p') {
      void (async () => {
        try {
          const res = await p2pPlay({ type: 'resign' });
          if (res.ok === false) {
            useGameStore.setState({
              statusDetail: res.detail || res.error || 'Resign failed',
            });
            return;
          }
          if (res.pending) {
            scheduleP2PUnlockTimeout(s.p2pSeq);
            return;
          }
          if (res.state) {
            const ev = Array.isArray(res.events) ? (res.events as MoveEvent[]) : [];
            await applyP2PUpdate({
              state: res.state as GameState,
              events: ev.length <= 200 ? ev : [],
              seq: res.seq ?? s.p2pSeq + 1,
              animate: ev.length > 0 && ev.length <= 200,
            });
          }
        } catch (err) {
          useGameStore.setState({
            statusDetail: err instanceof Error ? err.message : String(err),
          });
        }
      })();
      return;
    }
    abortAnim();
    const player = s.mode === 'ai' ? s.humanPlayer : s.committed.toMove;
    const { state, events } = engineResign(s.committed, player);
    pushHistory(s.committed);
    set({
      committed: state,
      lastEvents: events,
    });
    enterMatchOver(state, {
      mode: s.mode,
      humanPlayer: s.humanPlayer,
    });
  },

  skipAnimation: () => {
    abortAnim();
    const c = get().committed;
    if (!c) return;
    const session = get();
    if (isTerminal(c)) {
      // enterMatchOver de-dupes SFX if we already transitioned to 'over'
      enterMatchOver(c, {
        mode: session.mode,
        humanPlayer: session.humanPlayer,
      });
      return;
    }
    set({
      displayPits: c.pits.slice(),
      displayScore: { ...c.score },
      displayProtected: c.protectedMask.slice(),
      displayRound: c.roundIndex,
      inputLocked: false,
      thinking: false,
      selectedPit: null,
      pendingDirection: false,
      highlightPit: null,
      highlightPitsExtra: [],
      highlightKind: 'none',
      highlightDir: null,
      displayHand: null,
      captureFlight: null,
      animBudgetMs: 0,
      lastCaptureSide: null,
      turnPhase: phaseAfterState(c, session),
      statusMessage: statusHeadline(c, session),
      statusDetail: statusDetailFor(c, session),
    });
    queueMicrotask(() => get().resolveLoop());
  },

  toggleHints: () => set({ hintsEnabled: !get().hintsEnabled }),

  setCoachSeen: () => {
    try {
      localStorage.setItem('chennamane-coach-seen', '1');
    } catch {
      /* ignore */
    }
    set({ coachSeen: true, screen: 'home' });
  },

  dismissResult: () => set({ showResult: false }),

  resolveLoop: () => {
    scheduleResolve();
  },
}));

function abortAnim() {
  useGameStore.setState((s) => ({
    animationGeneration: s.animationGeneration + 1,
    inputLocked: false,
    thinking: false,
    searchCancelled: true,
    // Drop one-shot board FX so a remount cannot re-fire a stale capture flight
    captureFlight: null,
    animBudgetMs: 0,
    lastCaptureSide: null,
  }));
}

function pushHistory(prev: GameState) {
  useGameStore.setState((s) => ({
    historyPast: [...s.historyPast, prev].slice(-HISTORY_CAP),
    historyFuture: [],
  }));
}

/** Serialize auto-play (pass / AI) so skip+anim-end cannot run two resolve loops. */
let resolveChain: Promise<void> = Promise.resolve();

function scheduleResolve() {
  resolveChain = resolveChain
    .then(() => resolveNonHumanOrPass())
    .catch(() => {
      /* keep chain alive after unexpected errors */
    });
}

/** Prevents concurrent playHumanMove (double-tap / double key). */
let humanMoveInFlight = false;

async function playHumanMove(move: Move) {
  if (humanMoveInFlight) return;
  const s = useGameStore.getState();
  // selectPit / chooseDirection already gate on lock; reject any held lock here too
  // (AI / pass / anim). humanMoveInFlight covers double-submit before lock sticks.
  if (!s.committed || s.thinking || s.inputLocked) return;
  if (isTerminal(s.committed)) return;
  if ((s.mode === 'ai' || s.mode === 'p2p') && s.committed.toMove !== s.humanPlayer) return;

  const legal = getLegalMoves(s.committed);
  if (!legal.some((m) => m.startPit === move.startPit && m.direction === move.direction)) {
    return;
  }

  humanMoveInFlight = true;
  const prev = s.committed;
  const genAtStart = useGameStore.getState().animationGeneration;
  // Lock immediately so a double-tap cannot apply two moves before animation starts.
  useGameStore.setState({
    inputLocked: true,
    selectedPit: null,
    pendingDirection: false,
  });
  try {
    // P2P: engine authority lives on host worker; animate from returned/broadcast events
    if (s.mode === 'p2p') {
      if (!s.p2pConnected) {
        useGameStore.setState({
          inputLocked: false,
          statusDetail: 'Waiting for opponent to join…',
        });
        return;
      }
      try {
        const res = await p2pPlay({ type: 'move', move });
        if (res.ok === false) {
          useGameStore.setState({
            inputLocked: false,
            statusDetail: res.detail || res.error || 'Move rejected',
          });
          return;
        }
        if (res.state) {
          const ev = Array.isArray(res.events) ? (res.events as MoveEvent[]) : [];
          await applyP2PUpdate({
            state: res.state as GameState,
            events: ev.length <= 200 ? ev : [],
            seq: res.seq ?? s.p2pSeq + 1,
            animate: ev.length > 0 && ev.length <= 200,
          });
        } else if (res.pending) {
          useGameStore.setState({
            statusMessage: 'Move sent',
            statusDetail: 'Waiting for host…',
          });
          scheduleP2PUnlockTimeout(useGameStore.getState().p2pSeq);
        } else {
          useGameStore.setState({
            inputLocked: false,
            statusDetail: 'Unexpected response from host.',
          });
        }
      } catch (err) {
        useGameStore.setState({
          inputLocked: false,
          statusDetail: err instanceof Error ? err.message : String(err),
        });
      }
      return;
    }

    let state: GameState;
    let events: MoveEvent[];
    try {
      ({ state, events } = applyMove(prev, move));
    } catch {
      useGameStore.setState({ inputLocked: false });
      return;
    }
    pushHistory(prev);
    await commitAndAnimate(state, events, {
      actor: playerLabel(prev.toMove, s.mode, s.humanPlayer, p2pNames(s)),
      isAi: false,
      captureSide: prev.toMove,
    });
    // Only continue auto-play if this move's generation still owns the board
    // (skip/undo bumps gen and schedules its own resolve).
    if (useGameStore.getState().animationGeneration === genAtStart) {
      scheduleResolve();
    }
  } finally {
    humanMoveInFlight = false;
  }
}

async function commitAndAnimate(
  state: GameState,
  events: MoveEvent[],
  meta: { actor: string; isAi: boolean; captureSide?: PlayerId },
) {
  const gen = useGameStore.getState().animationGeneration;
  useGameStore.setState({
    committed: state,
    lastEvents: events,
    inputLocked: true,
    thinking: false,
    turnPhase: meta.isAi ? 'ai-playing' : 'animating',
    selectedPit: null,
    pendingDirection: false,
    highlightDir: null,
    statusMessage: meta.isAi ? `${meta.actor} sowing` : 'Sowing',
    statusDetail: '',
  });
  await playEvents(events, gen, meta);
  const cur = useGameStore.getState();
  if (cur.animationGeneration !== gen) return;

  if (isTerminal(state)) {
    enterMatchOver(state, {
      mode: cur.mode,
      humanPlayer: cur.humanPlayer,
    });
    return;
  }

  const nextPhase = phaseAfterState(state, cur);
  useGameStore.setState({
    displayPits: state.pits.slice(),
    displayScore: { ...state.score },
    displayProtected: state.protectedMask.slice(),
    displayRound: state.roundIndex,
    inputLocked: false,
    showResult: false,
    turnPhase: nextPhase,
    highlightPit: null,
    highlightPitsExtra: [],
    highlightKind: 'none',
    highlightDir: null,
    displayHand: null,
    // Flight FX is one-shot; drop it so a later remount cannot re-fire.
    captureFlight: null,
    animBudgetMs: 0,
    lastCaptureSide: null,
    statusMessage: statusHeadline(state, cur),
    statusDetail: statusDetailFor(state, cur),
  });
}

function phaseAfterState(
  state: GameState,
  session: Pick<GameSession, 'mode' | 'humanPlayer'>,
): TurnPhase {
  if (isTerminal(state)) return 'over';
  if (session.mode === 'ai') {
    if (state.toMove === session.humanPlayer) return 'your-turn';
    return 'ai-thinking';
  }
  if (session.mode === 'p2p') {
    return state.toMove === session.humanPlayer ? 'your-turn' : 'hotseat-turn';
  }
  return 'hotseat-turn';
}

function p2pNames(session: Pick<GameSession, 'p2pLocalName' | 'p2pRemoteName'>) {
  return { local: session.p2pLocalName, remote: session.p2pRemoteName };
}

function statusHeadline(
  state: GameState,
  session: Pick<
    GameSession,
    'mode' | 'humanPlayer' | 'p2pRoomCode' | 'p2pConnected' | 'p2pLocalName' | 'p2pRemoteName'
  >,
): string {
  if (isTerminal(state)) return 'Game over';
  if (needsSecondSowing(state)) {
    const who = playerLabel(
      state.toMove,
      session.mode,
      session.humanPlayer,
      p2pNames(session),
    );
    return who === session.p2pLocalName || who === 'You'
      ? 'Capture! Sow again'
      : `${who}: second sowing`;
  }
  if (session.mode === 'ai') {
    return state.toMove === session.humanPlayer ? 'Your turn' : "AI's turn";
  }
  if (session.mode === 'p2p') {
    if (!session.p2pConnected) return 'Waiting for opponent';
    if (state.toMove === session.humanPlayer) return 'Your turn';
    return `${session.p2pRemoteName || 'Opponent'}'s turn`;
  }
  return `${state.toMove === 'S' ? 'South' : 'North'} to move`;
}

function statusDetailFor(
  state: GameState,
  session: Pick<
    GameSession,
    'mode' | 'humanPlayer' | 'p2pRoomCode' | 'p2pConnected' | 'p2pLocalName' | 'p2pRemoteName'
  >,
): string {
  if (isTerminal(state)) return '';
  if (needsSecondSowing(state)) {
    if (
      (session.mode === 'ai' || session.mode === 'p2p') &&
      state.toMove === session.humanPlayer
    ) {
      return 'You captured — you must sow again from a legal pit.';
    }
    return 'Forced second sowing after a capture.';
  }
  if (session.mode === 'ai' && state.toMove === session.humanPlayer) {
    return humanRowHint(session.humanPlayer);
  }
  if (session.mode === 'ai') {
    return aiRowHint(session.humanPlayer);
  }
  if (session.mode === 'p2p') {
    if (!session.p2pConnected) {
      return session.p2pRoomCode
        ? `Room ${session.p2pRoomCode} — share this code with a friend.`
        : 'Connecting…';
    }
    return state.toMove === session.humanPlayer
      ? humanRowHint(session.humanPlayer)
      : `${session.p2pRemoteName || 'Opponent'} is thinking.`;
  }
  return 'Pick a pit on your row.';
}

let p2pSubscribed = false;
/** Prevents double-click host/join before React re-renders disabled buttons. */
let p2pLobbyOpInFlight = false;
/** Prevents stacked reconnect dials (status auto-reconnect + UI button). */
let p2pReconnectOpInFlight = false;
/** Serial queue without retaining an unbounded promise chain (memory). */
let p2pQueueBusy = false;
const p2pQueue: Array<() => Promise<void>> = [];
const P2P_QUEUE_MAX = 8;
const p2pPendingTimeouts = new Set<ReturnType<typeof setTimeout>>();

function clearP2PPendingTimeouts() {
  for (const t of p2pPendingTimeouts) clearTimeout(t);
  p2pPendingTimeouts.clear();
}

function scheduleP2PUnlockTimeout(seqAtSend: number) {
  const t = window.setTimeout(() => {
    p2pPendingTimeouts.delete(t);
    const cur = useGameStore.getState();
    if (
      cur.mode === 'p2p' &&
      cur.inputLocked &&
      cur.p2pSeq === seqAtSend &&
      !cur.showResult
    ) {
      useGameStore.setState({
        inputLocked: false,
        statusDetail: cur.p2pConnected
          ? 'No response from host — try again.'
          : 'Disconnected from peer.',
      });
    }
  }, 12_000);
  p2pPendingTimeouts.add(t);
}

function enqueueP2P(task: () => Promise<void>) {
  if (p2pQueue.length >= P2P_QUEUE_MAX) {
    // Drop oldest non-running work — prefer freshest board state
    p2pQueue.shift();
  }
  p2pQueue.push(task);
  void drainP2PQueue();
}

async function drainP2PQueue() {
  if (p2pQueueBusy) return;
  p2pQueueBusy = true;
  try {
    while (p2pQueue.length > 0) {
      const task = p2pQueue.shift()!;
      try {
        await task();
      } catch (err) {
        console.error('[p2p game]', err);
      }
    }
  } finally {
    p2pQueueBusy = false;
  }
}

function ensureP2PSubscriptions() {
  if (p2pSubscribed || !isP2PAvailable()) return;
  p2pSubscribed = true;
  onP2PGame((g) => {
    enqueueP2P(() => handleP2PGameEvent(g));
  });
  onP2PMatchReady((m) => {
    enqueueP2P(() => startP2PMatchWhenPeerReady(m));
  });
  onP2PStatus((s) => {
    // Ignore heartbeat pongs (noise)
    if (s.status === 'pong') return;

    // Host data-channel open is not a match join — wait for HELLO / match_ready
    if (s.status === 'channel_open') {
      return;
    }

    const disconnected =
      s.status === 'peer_disconnected' || s.status === 'peer_goodbye';
    const reconnecting =
      s.status === 'reconnecting' || s.status === 'peer_reconnecting';
    const reconnected = s.status === 'peer_reconnected';
    const connected =
      !disconnected &&
      !reconnecting &&
      Boolean(
        (s.connected && s.status !== 'channel_open') ||
          s.status === 'peer_connected' ||
          reconnected,
      );

    let guestShouldReconnect = false;

    useGameStore.setState((cur) => {
      // Lobby waiting (still on home)
      if (cur.screen === 'home' && (cur.p2pLobbyStatus === 'hosting' || cur.p2pLobbyStatus === 'joining')) {
        if (disconnected) {
          // Guest still joining: transport should redial (web auto; desktop via reconnectP2P)
          if (cur.p2pLobbyStatus === 'joining') guestShouldReconnect = true;
          return {
            p2pConnected: false,
            p2pReconnecting: cur.p2pLobbyStatus === 'joining',
            p2pLocalName: preferPlayerName(s.localPlayerName, cur.p2pLocalName),
            // Host keeps waiting for reconnect / new guest; don't wipe name for host
            p2pRemoteName:
              cur.p2pLobbyStatus === 'hosting' ? cur.p2pRemoteName : cur.p2pRemoteName,
            p2pLobbyMessage:
              cur.p2pLobbyStatus === 'hosting'
                ? `Room ${cur.p2pRoomCode || '—'} — opponent left. Waiting for them to rejoin…`
                : 'Disconnected from host — reconnecting…',
          };
        }
        // Host lobby: remember guest name as soon as HELLO is seen (desktop peer_hello)
        if (
          cur.p2pLobbyStatus === 'hosting' &&
          (s.status === 'peer_hello' || s.status === 'peer_connected') &&
          s.remotePlayerName
        ) {
          return {
            p2pRemoteName: s.remotePlayerName,
            p2pLobbyMessage: `${s.remotePlayerName} is joining…`,
          };
        }
        if (s.remotePlayerName && cur.p2pLobbyStatus === 'joining') {
          return { p2pRemoteName: s.remotePlayerName };
        }
        if (connected && cur.p2pLobbyStatus === 'joining') {
          return {
            p2pConnected: true,
            p2pReconnecting: false,
            p2pLobbyMessage: s.remotePlayerName
              ? `Connected to ${s.remotePlayerName} — loading board…`
              : `Found host — syncing board…`,
          };
        }
        return {};
      }

      if (cur.mode !== 'p2p') return {};
      const room = s.roomCode || cur.p2pRoomCode;
      const who = s.remotePlayerName ?? cur.p2pRemoteName;
      const localKeep = preferPlayerName(s.localPlayerName, cur.p2pLocalName);

      if (reconnecting) {
        return {
          p2pConnected: false,
          p2pReconnecting: true,
          p2pRoomCode: room,
          p2pRemoteName: who,
          p2pLocalName: localKeep,
          statusMessage: 'Reconnecting…',
          statusDetail: room
            ? `Room ${room} — trying to reach ${who || 'opponent'}…`
            : 'Trying to reconnect…',
          inputLocked: true,
        };
      }

      if (disconnected) {
        // Guest mid-match must rejoin; host waits for peer
        if (cur.humanPlayer === 'N') guestShouldReconnect = true;
        return {
          p2pConnected: false,
          p2pReconnecting: cur.humanPlayer === 'N',
          p2pRoomCode: room,
          p2pRemoteName: who,
          p2pLocalName: localKeep,
          statusMessage: 'Opponent disconnected',
          statusDetail: who
            ? cur.humanPlayer === 'N'
              ? `Reconnecting to ${who} (room ${room || '—'})…`
              : `Waiting for ${who} to rejoin room ${room || '—'}…`
            : cur.humanPlayer === 'N'
              ? `Reconnecting to room ${room || '—'}…`
              : `Waiting for peer to rejoin room ${room || '—'}…`,
          inputLocked: true,
        };
      }

      if (connected || reconnected) {
        const next = {
          ...cur,
          p2pConnected: true,
          p2pReconnecting: false,
          p2pRoomCode: room,
          p2pRemoteName: who,
          p2pLocalName: localKeep,
        };
        return {
          p2pConnected: true,
          p2pReconnecting: false,
          p2pRoomCode: room,
          p2pRemoteName: who,
          p2pLocalName: localKeep,
          statusMessage: cur.committed
            ? statusHeadline(cur.committed, next)
            : reconnected
              ? 'Reconnected'
              : who
                ? `Connected to ${who}`
                : 'Peer online',
          statusDetail: cur.committed
            ? statusDetailFor(cur.committed, next)
            : who
              ? `Playing ${who}`
              : 'Opponent is back',
          // Host can resume after HELLO; guest stays locked until STATE resync
          inputLocked:
            cur.humanPlayer === 'S' && cur.committed ? false : cur.inputLocked,
        };
      }

      return {};
    });

    // Guest auto-reconnect (desktop Pear + backup for web)
    if (guestShouldReconnect) {
      queueMicrotask(() => {
        const g = useGameStore.getState();
        if (g.p2pConnected || p2pReconnectOpInFlight) return;
        if (g.p2pLobbyStatus === 'joining' || (g.mode === 'p2p' && g.humanPlayer === 'N')) {
          void g.reconnectP2P();
        }
      });
    }
  });
  onP2PError((message) => {
    useGameStore.setState({
      statusDetail: message,
      inputLocked: false,
      p2pLobbyMessage: message,
    });
  });
  onP2PReject((reason) => {
    useGameStore.setState({
      inputLocked: false,
      thinking: false,
      statusDetail: reason,
    });
  });
}

/** Host: peer HELLO received — open the real match board. */
async function startP2PMatchWhenPeerReady(m: {
  localPlayerName?: string;
  remotePlayerName?: string | null;
  roomCode?: string | null;
  role?: 'host' | 'guest' | null;
  localSide?: 'S' | 'N' | null;
}) {
  const cur = useGameStore.getState();
  // Host opens on match_ready; guest opens on first STATE (handleP2PGameEvent)
  if (cur.screen === 'game' && cur.mode === 'p2p') {
    useGameStore.setState({
      p2pRemoteName: m.remotePlayerName ?? cur.p2pRemoteName,
      p2pLocalName: m.localPlayerName || cur.p2pLocalName,
      p2pConnected: true,
    });
    return;
  }
  if (cur.p2pLobbyStatus !== 'hosting') {
    // Guest: store names from WELCOME; board opens on STATE
    if (cur.p2pLobbyStatus === 'joining') {
      const remote = m.remotePlayerName ?? cur.p2pRemoteName;
      useGameStore.setState({
        p2pLocalName: m.localPlayerName || cur.p2pLocalName,
        p2pRemoteName: remote,
        p2pConnected: true,
        p2pLobbyMessage: `Connected to ${remote || 'host'} — loading board…`,
      });
    }
    return;
  }
  try {
    const snap = await p2pSnapshot();
    const hostState = (snap?.state as GameState) || null;
    const initialSeq = typeof snap?.seq === 'number' ? snap.seq : 1;
    const localName =
      m.localPlayerName ||
      snap.localPlayerName ||
      cur.p2pLocalName ||
      'Player';
    const remoteName =
      m.remotePlayerName ?? snap.remotePlayerName ?? cur.p2pRemoteName;
    openP2PMatch({
      roomCode: m.roomCode || cur.p2pRoomCode || '',
      human: 'S',
      role: 'host',
      state: hostState,
      connected: true,
      initialSeq,
      localName,
      remoteName,
    });
    useGameStore.setState({
      p2pLocalName: localName,
      p2pRemoteName: remoteName,
      p2pConnected: true,
      p2pReconnecting: false,
      statusMessage: 'Your turn',
      statusDetail: `Playing ${remoteName || 'opponent'} — room ${m.roomCode || cur.p2pRoomCode}`,
      turnPhase:
        hostState && hostState.toMove === 'S' ? 'your-turn' : 'hotseat-turn',
    });
  } catch (err) {
    useGameStore.setState({
      p2pLobbyStatus: 'error',
      p2pLobbyMessage: err instanceof Error ? err.message : String(err),
    });
  }
}

function openP2PMatch(opts: {
  roomCode: string;
  human: PlayerId;
  role: 'host' | 'guest';
  state: GameState | null;
  connected: boolean;
  /** Initial sync seq so early STATE events are not double-applied */
  initialSeq?: number;
  localName?: string;
  remoteName?: string | null;
}) {
  const gen = useGameStore.getState().animationGeneration + 1;
  const committed = opts.state;
  const prot = committed?.protectedMask;
  const prev = useGameStore.getState();
  useGameStore.setState({
    screen: 'game',
    mode: 'p2p',
    humanPlayer: opts.human,
    p2pLocalName: opts.localName || prev.p2pLocalName,
    p2pRemoteName:
      opts.remoteName !== undefined ? opts.remoteName : prev.p2pRemoteName,
    committed,
    displayPits: committed ? committed.pits.slice() : EMPTY_PITS14,
    displayScore: committed
      ? { S: committed.score.S, N: committed.score.N, E: committed.score.E ?? 0 }
      : EMPTY_SCORE,
    displayProtected:
      prot && prot.some(Boolean) ? prot.slice() : EMPTY_PROTECTED14,
    displayRound: committed ? committed.roundIndex : 0,
    historyPast: [],
    historyFuture: [],
    inputLocked: false,
    thinking: false,
    turnPhase: committed
      ? phaseAfterState(committed, { mode: 'p2p', humanPlayer: opts.human })
      : 'hotseat-turn',
    highlightPit: null,
    highlightPitsExtra: [],
    highlightKind: 'none',
    highlightDir: null,
    displayHand: null,
    captureFlight: null,
    animBudgetMs: 0,
    lastCaptureSide: null,
    selectedPit: null,
    pendingDirection: false,
    animationGeneration: gen,
    lastEvents: [],
    showResult: false,
    lastMatchEndReason: null,
    previewPits: [],
    previewKind: 'none',
    searchCancelled: true,
    p2pRoomCode: opts.roomCode,
    p2pConnected: opts.connected,
    p2pSeq: typeof opts.initialSeq === 'number' ? opts.initialSeq : 0,
    p2pLobbyStatus: 'idle',
    p2pLobbyMessage: '',
  });
}

async function handleP2PGameEvent(g: P2PGamePayload) {
  const cur = useGameStore.getState();

  const namePatch: Partial<GameSession> = {};
  if (g.remotePlayerName) namePatch.p2pRemoteName = g.remotePlayerName;
  if (g.localPlayerName) {
    namePatch.p2pLocalName = preferPlayerName(g.localPlayerName, cur.p2pLocalName);
  }

  // Guest still on home lobby: first STATE opens the match
  if (cur.mode !== 'p2p') {
    if (
      cur.p2pLobbyStatus === 'joining' &&
      g.state &&
      isValidGameState(g.state) &&
      (g.reason === 'welcome' ||
        g.reason === 'reconnect' ||
        g.reason === 'state' ||
        g.seq)
    ) {
      const remote =
        g.remotePlayerName || cur.p2pRemoteName || namePatch.p2pRemoteName || null;
      const local = preferPlayerName(g.localPlayerName, cur.p2pLocalName);
      openP2PMatch({
        roomCode: cur.p2pRoomCode || g.roomCode || '',
        human: 'N',
        role: 'guest',
        state: g.state,
        connected: true,
        initialSeq: typeof g.seq === 'number' ? g.seq : 0,
        localName: local,
        remoteName: remote,
      });
      useGameStore.setState({
        p2pLocalName: local,
        p2pRemoteName: remote,
        p2pConnected: true,
        p2pReconnecting: false,
        statusMessage: g.yourTurn ? 'Your turn' : `${remote || 'Opponent'}'s turn`,
        statusDetail: `Playing ${remote || 'host'} — room ${cur.p2pRoomCode || ''}`,
        turnPhase: phaseAfterState(g.state, {
          mode: 'p2p',
          humanPlayer: 'N',
        }),
      });
      return;
    }
    if (Object.keys(namePatch).length) useGameStore.setState(namePatch);
    return;
  }

  if (Object.keys(namePatch).length) {
    useGameStore.setState(namePatch);
  }

  if (g.localSide && g.localSide !== cur.humanPlayer) {
    useGameStore.setState({ humanPlayer: g.localSide });
  }

  if (!g.state || !isValidGameState(g.state)) return;
  const seq = g.seq ?? 0;
  // Host already applied via play() response — skip duplicate broadcast of same seq
  // (except reconnect resync which re-sends the current board)
  if (seq > 0 && seq <= cur.p2pSeq && g.reason !== 'reconnect') {
    if (g.yourTurn != null) {
      const next = { ...useGameStore.getState(), p2pConnected: true, ...namePatch };
      useGameStore.setState({
        p2pConnected: true,
        p2pReconnecting: false,
        statusMessage: next.committed
          ? statusHeadline(next.committed as GameState, next)
          : cur.statusMessage,
      });
    }
    return;
  }

  const state = g.state;
  const events = (g.events || []) as MoveEvent[];
  // Cap animation payload — huge sowing chains are applied as snapshots
  const animate =
    events.length > 0 &&
    events.length <= 200 &&
    g.reason !== 'welcome' &&
    g.reason !== 'host_create' &&
    g.reason !== 'snapshot' &&
    g.reason !== 'reconnect';
  // Reconnect may re-send same seq — force apply by lowering local watermark
  if (g.reason === 'reconnect' && seq > 0 && seq <= cur.p2pSeq) {
    useGameStore.setState({ p2pSeq: Math.max(0, seq - 1) });
  }
  await applyP2PUpdate({
    state,
    events: animate ? events : [],
    seq,
    animate,
  });
  if (g.reason === 'reconnect' || g.reason === 'welcome') {
    const after = useGameStore.getState();
    useGameStore.setState({
      p2pConnected: true,
      p2pReconnecting: false,
      inputLocked: false,
      statusMessage: after.committed
        ? statusHeadline(after.committed, { ...after, p2pConnected: true })
        : 'Reconnected',
      statusDetail: after.committed
        ? statusDetailFor(after.committed, { ...after, p2pConnected: true })
        : '',
    });
  }
}

async function applyP2PUpdate(opts: {
  state: GameState;
  events: MoveEvent[];
  seq: number;
  animate: boolean;
}) {
  const { state, events, seq, animate } = opts;
  const s = useGameStore.getState();
  if (s.mode !== 'p2p') return;

  // Ignore stale or already-applied seq (prevents double-apply races)
  if (seq > 0 && seq <= s.p2pSeq) return;

  useGameStore.setState({ p2pSeq: Math.max(s.p2pSeq, seq), p2pConnected: true });

  if (animate && events.length > 0) {
    const actorSide = s.committed?.toMove ?? s.humanPlayer;
    await commitAndAnimate(state, events, {
      actor: playerLabel(actorSide, 'p2p', s.humanPlayer, p2pNames(s)),
      isAi: actorSide !== s.humanPlayer,
      captureSide: actorSide,
    });
    // Drop event list after anim — frees move-event arrays held in store
    clearP2PPendingTimeouts();
    useGameStore.setState({ lastEvents: [], historyPast: [], historyFuture: [] });
  } else {
    // Snapshot board (welcome / first join) — no history growth in p2p
    clearP2PPendingTimeouts();
    const protectedMask = state.protectedMask;
    useGameStore.setState({
      committed: state,
      displayPits: state.pits.slice(),
      displayScore: {
        S: state.score.S,
        N: state.score.N,
        E: state.score.E ?? 0,
      },
      // Shared empty mask when nothing is protected (read-only consumers)
      displayProtected:
        protectedMask && protectedMask.some(Boolean)
          ? protectedMask.slice()
          : EMPTY_PROTECTED14,
      displayRound: state.roundIndex,
      historyPast: [],
      historyFuture: [],
      lastEvents: [],
      inputLocked: false,
      thinking: false,
      turnPhase: phaseAfterState(state, s),
      selectedPit: null,
      pendingDirection: false,
      highlightPit: null,
      highlightPitsExtra: [],
      highlightKind: 'none',
      displayHand: null,
      captureFlight: null,
      animBudgetMs: 0,
      previewPits: [],
      previewKind: 'none',
      showResult: isTerminal(state),
      statusMessage: statusHeadline(state, { ...s, p2pConnected: true }),
      statusDetail: statusDetailFor(state, { ...s, p2pConnected: true }),
    });
    if (isTerminal(state)) {
      enterMatchOver(state, { mode: 'p2p', humanPlayer: s.humanPlayer });
    }
  }

  // Auto-pass when local player has empty row
  const after = useGameStore.getState();
  if (
    after.mode === 'p2p' &&
    after.committed &&
    !isTerminal(after.committed) &&
    after.committed.toMove === after.humanPlayer &&
    getLegalMoves(after.committed).length === 0
  ) {
    try {
      const res = await p2pPlay({ type: 'pass' });
      if (res.pending) {
        scheduleP2PUnlockTimeout(after.p2pSeq);
        return;
      }
      if (res.state) {
        const ev = (res.events || []) as MoveEvent[];
        await applyP2PUpdate({
          state: res.state as GameState,
          events: ev.length <= 200 ? ev : [],
          seq: res.seq ?? after.p2pSeq + 1,
          animate: ev.length > 0 && ev.length <= 200,
        });
      }
    } catch {
      useGameStore.setState({ inputLocked: false });
    }
  }
}

async function playEvents(
  events: MoveEvent[],
  gen: number,
  meta: { actor: string; isAi: boolean; captureSide?: PlayerId },
) {
  const dropCount = events.filter((e) => e.type === 'drop').length;
  let pits = useGameStore.getState().displayPits.slice();
  let score = { ...useGameStore.getState().displayScore };
  let lastBatch = false;
  const captureSide = meta.captureSide ?? null;

  for (const e of events) {
    if (useGameStore.getState().animationGeneration !== gen) return;
    // Re-read speed each event so the HUD slider applies mid-sowing
    const pace = eventPacing(useGameStore.getState().settings);
    const batch = shouldBatchSow(pace.drop, dropCount);
    lastBatch = batch;
    switch (e.type) {
      case 'pickup':
        if (!batch) sfx.pickup(e.pit);
        pits[e.pit] = 0;
        useGameStore.setState({
          displayPits: pits.slice(),
          // Batch: no hop highlights (same rule as drop) — counts must not lag.
          highlightPit: batch ? null : e.pit,
          highlightPitsExtra: [],
          highlightKind: batch ? 'none' : 'pickup',
          // Drop-base budget for settle visuals (same drop the store paced from).
          animBudgetMs: batch ? 0 : pace.drop,
          displayHand: e.count,
          statusMessage: meta.isAi ? `${meta.actor} picks up` : 'Pick up',
          statusDetail: `${e.count} remaining · from ${INDEX_TO_LABEL[e.pit] ?? e.pit}`,
        });
        if (!(await sleepWhileCurrent(batch ? 0 : pace.pickup, gen))) return;
        break;
      case 'drop':
        // Hop contract (shared with Blender / Tour / Premium via hopMath):
        // 1) highlightKind 'drop' → boards hop for hopDurationMs(animBudgetMs)
        // 2) sleep full pace.drop so the bead finishes before the count lands
        // 3) only then increment displayPits (avoids double-count / teleport)
        // Batch / reduced-motion: do NOT use 'drop' — sleep is 0 and hop
        // visuals would lag far behind the count updates.
        useGameStore.setState({
          highlightPit: batch ? null : e.pit,
          highlightPitsExtra: [],
          highlightKind: batch ? 'none' : 'drop',
          // Boards read this exact budget — not a fresh HUD slider sample.
          animBudgetMs: batch ? 0 : pace.drop,
          displayHand: e.remainingInHand > 0 ? e.remainingInHand : null,
          statusDetail:
            e.remainingInHand > 0
              ? `${e.remainingInHand} remaining`
              : 'Last seed',
        });
        if (!batch) sfx.drop(e.pit);
        // Must re-check gen after the hop wait — skip/undo restores displayPits
        // and must not be overwritten by this delayed land.
        if (!(await sleepWhileCurrent(batch ? 0 : pace.drop, gen))) return;
        pits[e.pit] = (pits[e.pit] ?? 0) + 1;
        useGameStore.setState({ displayPits: pits.slice() });
        break;
      case 'continue':
        if (!batch) sfx.relay(e.pit);
        pits[e.pit] = 0;
        useGameStore.setState({
          displayPits: pits.slice(),
          highlightPit: batch ? null : e.pit,
          highlightPitsExtra: [],
          highlightKind: batch ? 'none' : 'continue',
          animBudgetMs: batch ? 0 : pace.drop,
          displayHand: e.count,
          statusDetail: `Continue · ${e.count} remaining · ${INDEX_TO_LABEL[e.pit] ?? e.pit}`,
        });
        if (!(await sleepWhileCurrent(batch ? 0 : pace.continue, gen))) return;
        break;
      case 'saada':
        if (!batch) sfx.saada(e.emptyPit);
        useGameStore.setState({
          highlightPit: batch ? null : e.emptyPit,
          highlightPitsExtra: [],
          highlightKind: batch ? 'none' : 'saada',
          animBudgetMs: batch ? 0 : pace.drop,
          displayHand: null,
          statusMessage: 'Saada',
          statusDetail: `${INDEX_TO_LABEL[e.emptyPit] ?? e.emptyPit} empty; capturing next.`,
        });
        if (!(await sleepWhileCurrent(batch ? 0 : pace.saada, gen))) return;
        break;
      case 'capture': {
        const total = e.amounts.reduce((a, b) => a + b, 0);
        const allCap = e.pits.slice();

        // Saada always emits a capture event — even when both bowls are empty.
        // Skip the long collect/flight beat for zero-amount "no capture" ends.
        if (total === 0) {
          for (const p of e.pits) pits[p] = 0;
          useGameStore.setState({
            displayPits: pits.slice(),
            highlightPit: batch ? null : (allCap[0] ?? null),
            highlightPitsExtra: batch ? [] : allCap.slice(1),
            highlightKind: batch ? 'none' : 'saada',
            animBudgetMs: batch ? 0 : pace.drop,
            displayHand: null,
            statusMessage: 'Saada',
            statusDetail: 'Nothing to capture — turn ends.',
          });
          if (
            !(await sleepWhileCurrent(
              batch ? 0 : Math.min(220, pace.saada),
              gen,
            ))
          ) {
            return;
          }
          break;
        }

        // Flash each capture bowl before clearing (collect animation)
        useGameStore.setState({
          highlightPit: batch ? null : (allCap[0] ?? null),
          highlightPitsExtra: batch ? [] : allCap.slice(1),
          highlightKind: batch ? 'none' : 'capture',
          animBudgetMs: batch ? 0 : pace.drop,
          statusMessage: `${meta.actor} captures`,
          statusDetail: allCap.map((p) => INDEX_TO_LABEL[p] ?? p).join(', '),
        });
        // Brief hold so both bowls pulse before seeds vanish
        if (
          !(await sleepWhileCurrent(
            batch
              ? 0
              : pace.capture > 0
                ? Math.min(280, Math.round(pace.capture * 0.35))
                : 0,
            gen,
          ))
        ) {
          return;
        }

        for (let i = 0; i < e.pits.length; i++) {
          const p = e.pits[i]!;
          pits[p] = 0;
        }
        // Credit the capturer from the running display score — do not read
        // committed.score here. On multi-round round-ends, committed is already
        // reseeded (banks after refill), which would flash the wrong totals.
        // Incremental also handles multi-capture sowings (e.g. pallanguzhi).
        if (captureSide === 'S' || captureSide === 'N' || captureSide === 'E') {
          score = {
            ...score,
            [captureSide]: (score[captureSide] ?? 0) + total,
          };
        }
        const flightSide =
          captureSide === 'S' || captureSide === 'N' ? captureSide : null;
        // No coconut flight in batch — drops already skipped hops; flight would
        // outlive the rest of the (instant) turn presentation.
        const flight: CaptureFlight | null =
          !batch && flightSide && pace.capture > 0
            ? {
                id: ++captureFlightSeq,
                side: flightSide,
                pits: e.pits
                  .map((p, i) => ({ pit: p, amount: e.amounts[i] ?? 0 }))
                  .filter((x) => x.amount > 0),
                // Visual flight must finish within this store sleep.
                budgetMs: pace.capture,
              }
            : null;
        useGameStore.setState({
          displayPits: pits.slice(),
          displayScore: score,
          highlightPit: batch ? null : (allCap[0] ?? null),
          highlightPitsExtra: batch ? [] : allCap.slice(1),
          highlightKind: batch ? 'none' : 'capture',
          animBudgetMs: batch ? 0 : pace.drop,
          displayHand: null,
          lastCaptureSide: batch ? null : captureSide,
          captureFlight: flight,
          statusMessage: `${meta.actor} +${total}`,
          statusDetail: e.pits.map((p) => INDEX_TO_LABEL[p] ?? p).join(', '),
        });
        sfx.capture(e.pits, total);
        if (!(await sleepWhileCurrent(batch ? 0 : pace.capture, gen))) return;
        // Flight budget is over — clear so a stale id cannot linger into the
        // next beat / turn (CaptureFlightSeeds only reacts to id changes).
        // Keep animBudgetMs until the next event / commit cleanup so boards do
        // not restart a settle when only the flight id is cleared.
        if (!batch) {
          useGameStore.setState({ lastCaptureSide: null, captureFlight: null });
        }
        break;
      }
      case 'pass':
        sfx.pass();
        useGameStore.setState({
          turnPhase: 'pass',
          statusMessage: `${meta.actor} passes`,
          statusDetail: 'Empty row.',
        });
        if (!(await sleepWhileCurrent(pace.pass, gen))) return;
        break;
      case 'turnEnd':
        if (!(await sleepWhileCurrent(pace.endBeat, gen))) return;
        break;
      case 'roundEnd': {
        // Board is spent; committed already holds the reseeded next round.
        // Snapshot before waits so a mid-wait commit swap does not reseed wrong.
        const next = useGameStore.getState().committed;
        sfx.round();
        useGameStore.setState({
          highlightPit: null,
          highlightPitsExtra: [],
          highlightKind: 'none',
          animBudgetMs: 0,
          statusMessage: `Round ${e.roundIndex + 1} complete`,
          statusDetail: 'Re-seeding from winnings…',
        });
        // Hold the spent board a beat, then present the reseeded one.
        if (!(await sleepWhileCurrent(Math.max(700, pace.hold), gen))) return;
        if (next) {
          pits = next.pits.slice();
          score = { ...next.score };
          const protectedCount = next.protectedMask.filter(Boolean).length;
          useGameStore.setState({
            displayPits: pits.slice(),
            displayScore: { ...score },
            displayProtected: next.protectedMask.slice(),
            displayRound: next.roundIndex,
            statusMessage: `Round ${next.roundIndex + 1}`,
            statusDetail:
              protectedCount > 0
                ? `${protectedCount} pit${protectedCount === 1 ? '' : 's'} closed (unfilled).`
                : 'All pits refilled.',
          });
        }
        if (!(await sleepWhileCurrent(Math.max(500, pace.reset), gen))) return;
        break;
      }
      case 'matchEnd': {
        // Outcome SFX is owned by enterMatchOver (after anim) so skip/abort
        // cannot double-play or silence the sting.
        const endReason = e.reason;
        useGameStore.setState({ lastMatchEndReason: endReason });
        const session = useGameStore.getState();
        const detail = session.committed
          ? outcomeStatusDetail(
              matchOutcome(
                session.committed,
                outcomeMeta({ ...session, endReason }),
              ),
            )
          : '';
        useGameStore.setState({
          statusMessage: 'Game over',
          statusDetail: detail,
        });
        if (!(await sleepWhileCurrent(pace.capture, gen))) return;
        break;
      }
      default:
        break;
    }
  }
  if (lastBatch && useGameStore.getState().animationGeneration === gen) {
    const pace = eventPacing(useGameStore.getState().settings);
    if (pace.drop > 0) sfx.drop();
  }
}

async function resolveNonHumanOrPass() {
  // Safety cap per chain entry; if still auto-play after this, we re-schedule
  // rather than soft-locking (e.g. AI forced second after many pass steps).
  const maxIter = 48;
  for (let i = 0; i < maxIter; i++) {
    const s = useGameStore.getState();
    if (!s.committed || s.inputLocked) return;
    if (isTerminal(s.committed)) {
      enterMatchOver(s.committed, {
        mode: s.mode,
        humanPlayer: s.humanPlayer,
      });
      return;
    }

    const moves = getLegalMoves(s.committed);
    if (moves.length === 0) {
      // P2P: only the local player submits a pass when it's their turn
      if (s.mode === 'p2p' && s.committed.toMove !== s.humanPlayer) {
        return;
      }
      const who = playerLabel(
        s.committed.toMove,
        s.mode,
        s.humanPlayer,
        p2pNames(s),
      );
      useGameStore.setState({
        turnPhase: 'pass',
        statusMessage: `${who} passes`,
        statusDetail: 'Empty row.',
        inputLocked: true,
      });
      await sleep(500);
      if (useGameStore.getState().animationGeneration !== s.animationGeneration) return;
      const prev = useGameStore.getState().committed;
      if (!prev || isTerminal(prev)) {
        if (prev && isTerminal(prev)) {
          enterMatchOver(prev, {
            mode: s.mode,
            humanPlayer: s.humanPlayer,
          });
        }
        return;
      }
      // Board may have changed during the pause — only pass if still empty-handed.
      if (getLegalMoves(prev).length > 0) {
        useGameStore.setState({ inputLocked: false });
        continue;
      }
      if (s.mode === 'p2p') {
        try {
          const res = await p2pPlay({ type: 'pass' });
          if (res.pending) {
            scheduleP2PUnlockTimeout(s.p2pSeq);
            return;
          }
          if (res.state) {
            const ev = (res.events || []) as MoveEvent[];
            await applyP2PUpdate({
              state: res.state as GameState,
              events: ev.length <= 200 ? ev : [],
              seq: res.seq ?? s.p2pSeq + 1,
              animate: ev.length > 0 && ev.length <= 200,
            });
          }
        } catch {
          useGameStore.setState({ inputLocked: false, thinking: false });
        }
        continue;
      }
      let state: GameState;
      let events: MoveEvent[];
      try {
        ({ state, events } = applyPass(prev));
      } catch {
        useGameStore.setState({ inputLocked: false, thinking: false });
        continue;
      }
      pushHistory(prev);
      await commitAndAnimate(state, events, {
        actor: who,
        isAi: s.mode === 'ai' && prev.toMove !== s.humanPlayer,
      });
      continue;
    }

    if (s.mode === 'p2p') {
      // Remote opponent plays — wait for STATE over peer protocol
      return;
    }

    if (s.mode === 'ai' && s.committed.toMove !== s.humanPlayer) {
      const genAtStart = useGameStore.getState().animationGeneration;
      const difficulty = s.aiDifficulty;
      const snapshot = s.committed;
      const isSecond = needsSecondSowing(snapshot);

      // Hand-off pause so human can register turn change
      if (!isSecond) {
        useGameStore.setState({
          thinking: true,
          turnPhase: 'ai-thinking',
          searchCancelled: false,
          inputLocked: true,
          highlightPit: null,
          highlightPitsExtra: [],
          highlightKind: 'none',
          highlightDir: null,
          statusMessage: "AI's turn",
          statusDetail: 'Thinking…',
        });
        await sleep(HANDOFF_TO_AI_MS);
      } else {
        useGameStore.setState({
          thinking: true,
          turnPhase: 'ai-thinking',
          searchCancelled: false,
          inputLocked: true,
          statusMessage: 'AI second sowing',
          statusDetail: 'Thinking…',
        });
        await sleep(AI_BETWEEN_SOWINGS_MS);
      }

      if (useGameStore.getState().animationGeneration !== genAtStart) {
        // Abort already unlocked; do not clear a newer loop's locks.
        return;
      }

      const thinkStarted = performance.now();
      let move: Move;
      try {
        move = search(snapshot, {
          difficulty,
          cancelled: () => useGameStore.getState().searchCancelled,
        });
      } catch {
        if (useGameStore.getState().animationGeneration !== genAtStart) {
          return;
        }
        // Search should not throw when moves exist; if a child node blows up
        // (invariant/max-drops), fall back to any legal move so we never leave
        // the AI side unlocked with no resolve scheduled.
        const live = useGameStore.getState().committed;
        const fallback = live ? getLegalMoves(live) : [];
        if (fallback.length === 0) {
          useGameStore.setState({ thinking: false, inputLocked: false });
          continue;
        }
        move = fallback[0]!;
      }

      // Keep "thinking" visible for a minimum duration
      const minThink = AI_MIN_THINK_MS[difficulty];
      const elapsed = performance.now() - thinkStarted;
      if (elapsed < minThink) {
        await sleep(minThink - elapsed);
      }

      if (useGameStore.getState().animationGeneration !== genAtStart) {
        return;
      }

      // Preview: show which pit + direction before seeds move
      const previewSeeds =
        (useGameStore.getState().committed ?? snapshot).pits[move.startPit] ?? 0;
      useGameStore.setState({
        thinking: false,
        turnPhase: 'ai-preview',
        highlightPit: move.startPit,
        highlightPitsExtra: [],
        highlightKind: 'ai',
        highlightDir: move.direction,
        statusMessage: 'AI move',
        statusDetail: `${INDEX_TO_LABEL[move.startPit] ?? move.startPit}, ${dirLabel(move.direction)}, ${previewSeeds} seeds`,
      });
      await sleep(AI_PREVIEW_MS);

      if (useGameStore.getState().animationGeneration !== genAtStart) {
        return;
      }

      const prev = useGameStore.getState().committed;
      if (!prev || isTerminal(prev)) {
        useGameStore.setState({ thinking: false, inputLocked: false, highlightPit: null });
        if (prev && isTerminal(prev)) {
          enterMatchOver(prev, {
            mode: s.mode,
            humanPlayer: s.humanPlayer,
          });
        }
        return;
      }
      // Re-validate — undo/race can invalidate the searched move.
      const stillLegal = getLegalMoves(prev).some(
        (m) => m.startPit === move.startPit && m.direction === move.direction,
      );
      if (!stillLegal) {
        useGameStore.setState({ thinking: false, inputLocked: false, highlightPit: null });
        continue;
      }
      let state: GameState;
      let events: MoveEvent[];
      try {
        ({ state, events } = applyMove(prev, move));
      } catch {
        useGameStore.setState({ thinking: false, inputLocked: false, highlightPit: null });
        continue;
      }
      pushHistory(prev);
      await commitAndAnimate(state, events, {
        actor: 'AI',
        isAi: true,
        captureSide: prev.toMove,
      });
      continue;
    }

    // human / hotseat to move
    useGameStore.setState({
      inputLocked: false,
      thinking: false,
      turnPhase: s.mode === 'ai' ? 'your-turn' : 'hotseat-turn',
      highlightPit: null,
      highlightPitsExtra: [],
      highlightKind: 'none',
      highlightDir: null,
      statusMessage: statusHeadline(s.committed, s),
      statusDetail: statusDetailFor(s.committed, s),
    });
    return;
  }

  // Cap hit but auto-play still required (AI second sowing, pass chains, …)
  const leftover = useGameStore.getState();
  if (
    leftover.committed &&
    !leftover.inputLocked &&
    !isTerminal(leftover.committed) &&
    (getLegalMoves(leftover.committed).length === 0 ||
      (leftover.mode === 'ai' && leftover.committed.toMove !== leftover.humanPlayer))
  ) {
    queueMicrotask(() => scheduleResolve());
  }
}

// hydrate coach flag
try {
  if (localStorage.getItem('chennamane-coach-seen') === '1') {
    useGameStore.setState({ coachSeen: true });
  }
} catch {
  /* ignore */
}

setSoundEnabled(useGameStore.getState().settings.soundEnabled ?? DEFAULT_SETTINGS.soundEnabled);
