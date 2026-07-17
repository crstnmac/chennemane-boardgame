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

export type Screen = 'home' | 'game' | 'rules' | 'settings' | 'coach';
export type { GameMode };
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

  setScreen: (s: Screen) => void;
  updateSettings: (partial: Partial<Settings>) => void;
  newGame: (
    mode: GameMode,
    opts?: {
      difficulty?: Difficulty;
      human?: PlayerId;
    },
  ) => void;
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
  const endReason =
    opts.endReason ?? useGameStore.getState().lastMatchEndReason ?? null;
  const outcome = matchOutcome(state, {
    mode: opts.mode,
    humanPlayer: opts.humanPlayer,
    endReason,
  });
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

  setScreen: (screen) => {
    // Leaving the game mid-anim/AI must cancel resolve loops so they don't
    // keep mutating state while the user is on home/rules/settings.
    if (screen !== 'game' && get().screen === 'game') {
      abortAnim();
      set({
        screen,
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

  selectPit: (pit) => {
    const { committed, inputLocked, mode, humanPlayer, thinking } = get();
    if (!committed || inputLocked || thinking || humanMoveInFlight || isTerminal(committed))
      return;
    if (mode === 'ai' && committed.toMove !== humanPlayer) {
      set({
        statusDetail: "Wait for the AI's turn to finish.",
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
        ? outcomeStatusDetail(
            matchOutcome(current, { mode: s.mode, humanPlayer: s.humanPlayer }),
          )
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
        ? outcomeStatusDetail(
            matchOutcome(current, { mode: s.mode, humanPlayer: s.humanPlayer }),
          )
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
  if (s.mode === 'ai' && s.committed.toMove !== s.humanPlayer) return;

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
      actor: playerLabel(prev.toMove, s.mode, s.humanPlayer),
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
  return 'hotseat-turn';
}

function statusHeadline(
  state: GameState,
  session: Pick<GameSession, 'mode' | 'humanPlayer'>,
): string {
  if (isTerminal(state)) return 'Game over';
  if (needsSecondSowing(state)) {
    const who = playerLabel(state.toMove, session.mode, session.humanPlayer);
    return who === 'You' ? 'Capture! Sow again' : `${who}: second sowing`;
  }
  if (session.mode === 'ai') {
    return state.toMove === session.humanPlayer ? 'Your turn' : "AI's turn";
  }
  return `${state.toMove === 'S' ? 'South' : 'North'} to move`;
}

function statusDetailFor(
  state: GameState,
  session: Pick<GameSession, 'mode' | 'humanPlayer'>,
): string {
  if (isTerminal(state)) return '';
  if (needsSecondSowing(state)) {
    if (session.mode === 'ai' && state.toMove === session.humanPlayer) {
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
  return 'Pick a pit on your row.';
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
              matchOutcome(session.committed, {
                mode: session.mode,
                humanPlayer: session.humanPlayer,
                endReason,
              }),
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
      const who = playerLabel(s.committed.toMove, s.mode, s.humanPlayer);
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
