import { create } from 'zustand';
import {
  applyMove,
  applyPass,
  createGame,
  getLegalMoves,
  INDEX_TO_LABEL,
  isTerminal,
  mergeConfig,
  needsSecondSowing,
  resign as engineResign,
  type GameState,
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
}

let captureFlightSeq = 0;

const HISTORY_CAP = 200;

/** Minimum time the "AI is thinking" state stays visible (ms). */
const AI_MIN_THINK_MS: Record<Difficulty, number> = {
  easy: 750,
  medium: 1100,
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

function isReducedMotion(settings: Settings): boolean {
  return (
    settings.reducedMotionOverride === 'always' ||
    (settings.reducedMotionOverride === 'auto' &&
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches)
  );
}

function eventPacing(settings: Settings) {
  return eventPaceFromDrop(
    dropMsForSpeed(settings.travelSpeed, isReducedMotion(settings)),
  );
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
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
  opts: { playSfx?: boolean; mode: GameMode; humanPlayer: PlayerId },
): void {
  const outcome = matchOutcome(state, {
    mode: opts.mode,
    humanPlayer: opts.humanPlayer,
  });
  if (outcome.kind === 'ongoing') return;

  if (opts.playSfx) {
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
    highlightPit: null,
    highlightPitsExtra: [],
    highlightKind: 'none',
    highlightDir: null,
    statusMessage: 'Game over',
    statusDetail: outcomeStatusDetail(outcome),
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

  setScreen: (screen) => set({ screen }),

  updateSettings: (partial) => {
    const settings = { ...get().settings, ...partial };
    const ok = saveSettings(settings);
    setSoundEnabled(settings.soundEnabled);
    set({ settings, settingsPersistFailed: !ok });
  },

  newGame: (mode, opts) => {
    const { settings } = get();
    setSoundEnabled(settings.soundEnabled);
    const gen = get().animationGeneration + 1;
    const human = opts?.human ?? 'S';
    const difficulty = opts?.difficulty ?? get().aiDifficulty;

    // Sole ruleset: Ali Guli Mane (+ settings seed/direction/series knobs)
    const engineConfig = mergeConfig({
      initialSeedsPerPit: settings.initialSeedsPerPit,
      directionMode: settings.directionMode,
      matchStructure: settings.multiRound ? 'multi-round-protected' : 'single',
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
      selectedPit: null,
      pendingDirection: false,
      hintsEnabled: settings.hintsDefault,
      animationGeneration: gen,
      lastEvents: [],
      showResult: false,
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
    const { committed, inputLocked, mode, humanPlayer, thinking, displayPits } =
      get();
    if (!committed || inputLocked || thinking || isTerminal(committed)) return;
    if (mode === 'ai' && committed.toMove !== humanPlayer) return;
    const legal = getLegalMoves(committed);
    if (!legal.some((m) => m.startPit === pit)) return;

    const hand = displayPits[pit] ?? committed.pits[pit] ?? 0;
    const dirMode = committed.config.directionMode;
    sfx.select(pit);
    if (dirMode === 'fixedCcw') {
      get().clearSelection();
      void playHumanMove({ startPit: pit, direction: 'ccw' });
      return;
    }
    if (dirMode === 'fixedCw') {
      get().clearSelection();
      void playHumanMove({ startPit: pit, direction: 'cw' });
      return;
    }
    set({
      selectedPit: pit,
      pendingDirection: true,
      highlightPit: pit,
      highlightPitsExtra: [],
      highlightKind: 'select',
      displayHand: hand > 0 ? hand : null,
      statusMessage: 'Choose direction',
      statusDetail: `${INDEX_TO_LABEL[pit] ?? pit} · ${hand} remaining.`,
    });
  },

  clearSelection: () =>
    set({
      selectedPit: null,
      pendingDirection: false,
      highlightPit: null,
      highlightPitsExtra: [],
      highlightKind: 'none',
      displayHand: null,
      statusMessage: 'Your turn',
      statusDetail: 'Tap a legal pit on your row.',
    }),

  chooseDirection: (dir) => {
    const { selectedPit } = get();
    if (selectedPit === null) return;
    const pit = selectedPit;
    set({ selectedPit: null, pendingDirection: false });
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
      displayScore: { ...current.score },
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
      showResult: isTerminal(current),
      statusMessage: isTerminal(current) ? 'Game over' : 'Undid move',
      statusDetail: isTerminal(current)
        ? outcomeStatusDetail(
            matchOutcome(current, { mode: s.mode, humanPlayer: s.humanPlayer }),
          )
        : you
          ? 'Your turn again.'
          : '',
    });
    queueMicrotask(() => get().resolveLoop());
  },

  redo: () => {
    const s = get();
    if (s.historyFuture.length === 0) return;
    abortAnim();
    const future = [...s.historyFuture];
    const past = s.committed ? [...s.historyPast, s.committed] : [...s.historyPast];
    const current = future.shift()!;
    set({
      committed: current,
      displayPits: current.pits.slice(),
      displayScore: { ...current.score },
      displayProtected: current.protectedMask.slice(),
      displayRound: current.roundIndex,
      historyPast: past.slice(-HISTORY_CAP),
      historyFuture: future,
      inputLocked: false,
      selectedPit: null,
      pendingDirection: false,
      highlightPit: null,
      highlightPitsExtra: [],
      highlightKind: 'none',
      highlightDir: null,
      displayHand: null,
      showResult: isTerminal(current),
      turnPhase: phaseAfterState(current, s),
      statusMessage: isTerminal(current) ? 'Game over' : 'Redid move',
      statusDetail: isTerminal(current)
        ? outcomeStatusDetail(
            matchOutcome(current, { mode: s.mode, humanPlayer: s.humanPlayer }),
          )
        : '',
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
      playSfx: true,
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
      enterMatchOver(c, {
        playSfx: false,
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
      highlightPit: null,
      highlightPitsExtra: [],
      highlightKind: 'none',
      highlightDir: null,
      displayHand: null,
      turnPhase: phaseAfterState(c, session),
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
    void resolveNonHumanOrPass();
  },
}));

function abortAnim() {
  useGameStore.setState((s) => ({
    animationGeneration: s.animationGeneration + 1,
    inputLocked: false,
    searchCancelled: true,
  }));
}

function pushHistory(prev: GameState) {
  useGameStore.setState((s) => ({
    historyPast: [...s.historyPast, prev].slice(-HISTORY_CAP),
    historyFuture: [],
  }));
}

async function playHumanMove(move: Move) {
  const s = useGameStore.getState();
  if (!s.committed || s.inputLocked) return;
  const legal = getLegalMoves(s.committed);
  if (!legal.some((m) => m.startPit === move.startPit && m.direction === move.direction)) {
    return;
  }
  const prev = s.committed;
  const { state, events } = applyMove(prev, move);
  pushHistory(prev);
  await commitAndAnimate(state, events, {
    actor: playerLabel(prev.toMove, s.mode, s.humanPlayer),
    isAi: false,
    captureSide: prev.toMove,
  });
  useGameStore.getState().resolveLoop();
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
      playSfx: false, // already played on matchEnd event during playEvents
      mode: cur.mode,
      humanPlayer: cur.humanPlayer,
    });
    // Ensure display synced if matchEnd was skipped (e.g. reduced motion race)
    if (!events.some((e) => e.type === 'matchEnd')) {
      enterMatchOver(state, {
        playSfx: true,
        mode: cur.mode,
        humanPlayer: cur.humanPlayer,
      });
    }
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
    return who === 'You' ? 'Second sowing' : `${who}: second sowing`;
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
      return 'Pick another pit on your row.';
    }
    return 'Extra turn after a capture.';
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
    const batch = pace.drop === 0 || dropCount > 60;
    lastBatch = batch;
    switch (e.type) {
      case 'pickup':
        if (!batch) sfx.pickup(e.pit);
        pits[e.pit] = 0;
        useGameStore.setState({
          displayPits: pits.slice(),
          highlightPit: e.pit,
          highlightPitsExtra: [],
          highlightKind: 'pickup',
          displayHand: e.count,
          statusMessage: meta.isAi ? `${meta.actor} picks up` : 'Pick up',
          statusDetail: `${e.count} remaining · from ${INDEX_TO_LABEL[e.pit] ?? e.pit}`,
        });
        if (pace.pickup) await sleep(pace.pickup);
        break;
      case 'drop':
        // Start hop first; only land the bead in displayPits when the hop
        // finishes — otherwise the pit gains a seed while one is still flying
        // (double-count / “teleport then hop” look).
        // Remaining count decrements as each seed leaves the hand.
        useGameStore.setState({
          highlightPit: e.pit,
          highlightPitsExtra: [],
          highlightKind: 'drop',
          displayHand: e.remainingInHand > 0 ? e.remainingInHand : null,
          statusDetail:
            e.remainingInHand > 0
              ? `${e.remainingInHand} remaining`
              : 'Last seed',
        });
        if (!batch) {
          sfx.drop(e.pit);
          if (pace.drop) await sleep(pace.drop);
        }
        pits[e.pit] = (pits[e.pit] ?? 0) + 1;
        useGameStore.setState({ displayPits: pits.slice() });
        break;
      case 'continue':
        if (!batch) sfx.relay(e.pit);
        pits[e.pit] = 0;
        useGameStore.setState({
          displayPits: pits.slice(),
          highlightPit: e.pit,
          highlightPitsExtra: [],
          highlightKind: 'continue',
          displayHand: e.count,
          statusDetail: `Continue · ${e.count} remaining · ${INDEX_TO_LABEL[e.pit] ?? e.pit}`,
        });
        if (pace.continue) await sleep(pace.continue);
        break;
      case 'saada':
        sfx.saada(e.emptyPit);
        useGameStore.setState({
          highlightPit: e.emptyPit,
          highlightPitsExtra: [],
          highlightKind: 'saada',
          displayHand: null,
          statusMessage: 'Saada',
          statusDetail: `${INDEX_TO_LABEL[e.emptyPit] ?? e.emptyPit} empty; capturing next.`,
        });
        if (pace.saada) await sleep(pace.saada);
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
            highlightPit: allCap[0] ?? null,
            highlightPitsExtra: allCap.slice(1),
            highlightKind: 'saada',
            displayHand: null,
            statusMessage: 'Saada',
            statusDetail: 'Nothing to capture — turn ends.',
          });
          if (pace.saada) await sleep(Math.min(220, pace.saada));
          break;
        }

        // Flash each capture bowl before clearing (collect animation)
        useGameStore.setState({
          highlightPit: allCap[0] ?? null,
          highlightPitsExtra: allCap.slice(1),
          highlightKind: 'capture',
          statusMessage: `${meta.actor} captures`,
          statusDetail: allCap.map((p) => INDEX_TO_LABEL[p] ?? p).join(', '),
        });
        // Brief hold so both bowls pulse before seeds vanish
        if (pace.capture) await sleep(Math.min(280, Math.round(pace.capture * 0.35)));

        for (let i = 0; i < e.pits.length; i++) {
          const p = e.pits[i]!;
          pits[p] = 0;
        }
        const committed = useGameStore.getState().committed;
        if (committed) {
          score = { ...committed.score };
        }
        const flightSide =
          captureSide === 'S' || captureSide === 'N' ? captureSide : null;
        const flight: CaptureFlight | null =
          flightSide && pace.capture > 0
            ? {
                id: ++captureFlightSeq,
                side: flightSide,
                pits: e.pits
                  .map((p, i) => ({ pit: p, amount: e.amounts[i] ?? 0 }))
                  .filter((x) => x.amount > 0),
              }
            : null;
        useGameStore.setState({
          displayPits: pits.slice(),
          displayScore: score,
          highlightPit: allCap[0] ?? null,
          highlightPitsExtra: allCap.slice(1),
          highlightKind: 'capture',
          displayHand: null,
          lastCaptureSide: captureSide,
          captureFlight: flight,
          statusMessage: `${meta.actor} +${total}`,
          statusDetail: e.pits.map((p) => INDEX_TO_LABEL[p] ?? p).join(', '),
        });
        sfx.capture(e.pits, total);
        if (pace.capture) await sleep(pace.capture);
        useGameStore.setState({ lastCaptureSide: null });
        break;
      }
      case 'pass':
        sfx.pass();
        useGameStore.setState({
          turnPhase: 'pass',
          statusMessage: `${meta.actor} passes`,
          statusDetail: 'Empty row.',
        });
        if (pace.pass) await sleep(pace.pass);
        break;
      case 'turnEnd':
        if (pace.endBeat) await sleep(pace.endBeat);
        break;
      case 'roundEnd': {
        // Board is spent; committed already holds the reseeded next round.
        const session = useGameStore.getState();
        const next = session.committed;
        sfx.round();
        useGameStore.setState({
          highlightPit: null,
          highlightPitsExtra: [],
          highlightKind: 'none',
          statusMessage: `Round ${e.roundIndex + 1} complete`,
          statusDetail: 'Re-seeding from winnings…',
        });
        // Hold the spent board a beat, then present the reseeded one.
        await sleep(Math.max(700, pace.hold));
        if (useGameStore.getState().animationGeneration !== gen) return;
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
        await sleep(Math.max(500, pace.reset));
        break;
      }
      case 'matchEnd': {
        const session = useGameStore.getState();
        const human = session.mode === 'ai' ? session.humanPlayer : null;
        sfx.matchOutcome(e.winner, human);
        const detail = session.committed
          ? outcomeStatusDetail(
              matchOutcome(session.committed, {
                mode: session.mode,
                humanPlayer: session.humanPlayer,
              }),
            )
          : '';
        useGameStore.setState({
          statusMessage: 'Game over',
          statusDetail: detail,
        });
        if (pace.capture) await sleep(pace.capture);
        break;
      }
      default:
        break;
    }
  }
  if (lastBatch) {
    const pace = eventPacing(useGameStore.getState().settings);
    if (pace.drop > 0) sfx.drop();
  }
}

async function resolveNonHumanOrPass() {
  const maxIter = 24;
  for (let i = 0; i < maxIter; i++) {
    const s = useGameStore.getState();
    if (!s.committed || s.inputLocked) return;
    if (isTerminal(s.committed)) {
      enterMatchOver(s.committed, {
        playSfx: false,
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
      const prev = useGameStore.getState().committed!;
      const { state, events } = applyPass(prev);
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
        useGameStore.setState({ thinking: false, inputLocked: false });
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
        useGameStore.setState({ thinking: false, inputLocked: false });
        return;
      }

      // Keep "thinking" visible for a minimum duration
      const minThink = AI_MIN_THINK_MS[difficulty];
      const elapsed = performance.now() - thinkStarted;
      if (elapsed < minThink) {
        await sleep(minThink - elapsed);
      }

      if (useGameStore.getState().animationGeneration !== genAtStart) {
        useGameStore.setState({ thinking: false, inputLocked: false });
        return;
      }

      // Preview: show which pit + direction before seeds move
      useGameStore.setState({
        thinking: false,
        turnPhase: 'ai-preview',
        highlightPit: move.startPit,
        highlightPitsExtra: [],
        highlightKind: 'ai',
        highlightDir: move.direction,
        statusMessage: 'AI move',
        statusDetail: `${INDEX_TO_LABEL[move.startPit] ?? move.startPit}, ${dirLabel(move.direction)}, ${snapshot.pits[move.startPit]} seeds`,
      });
      await sleep(AI_PREVIEW_MS);

      if (useGameStore.getState().animationGeneration !== genAtStart) {
        useGameStore.setState({ thinking: false, inputLocked: false, highlightPit: null });
        return;
      }

      const prev = useGameStore.getState().committed!;
      const { state, events } = applyMove(prev, move);
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
