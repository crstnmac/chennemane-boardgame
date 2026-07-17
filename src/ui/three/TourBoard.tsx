import {
  Suspense,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { OrbitControls, useGLTF } from '@react-three/drei';
import { animated, useSpring } from '@react-spring/three';
import * as THREE from 'three';
import {
  DEFAULT_CONFIG,
  executeSowing,
  INDEX_TO_LABEL,
  type Direction,
  type GameState,
  type MoveEvent,
  type PitIndex,
} from '../../engine';
import {
  dropMsForSpeed,
  eventPaceFromDrop,
  prefersReducedMotion,
  type EventPace,
  tourPaceFromSpeed,
  TRAVEL_SPEED_DEFAULT,
} from '../../session/animationPace';
import { useGameStore } from '../../session/store';
import { sfx } from '../../audio/sfx';
import { AnimatedPitCount, RowInitialMarker } from './AnimatedPitCount';
import { BOARD_URL, SEED_URL } from './assetUrls';
import { useBoardMaterialMaps } from './boardMaterialMaps';
import {
  BOARD_META,
  PITS,
  pitPosition,
  pitSurfacePosition,
  seedOffsets,
} from './layout';
import { RenderWake } from './RenderWake';
import {
  extractSeedGeometry,
  getSharedSeedMaterial,
  getStudioBoardRoot,
  preloadBoardAssets,
} from './sharedAssets';
import { GroundContactShadow } from './GroundContactShadow';
import { HomeVeranda } from './HomeVeranda';
import { FLYER_SCALE_BOOST, HERO_DPR, HOP_ARC_BOOST } from './quality';
import { StudioLights } from './StudioLights';
import { truncateTourEvents } from './tourEvents';
import {
  HOP_ARC_SEGMENTS,
  HOP_REST_Y,
  captureFlightDurationMs,
  hopDurationMs,
  hopPoint,
  randomHopLift,
  randomHopSkew,
  type Vec3,
} from '../hopMath';

export { truncateTourEvents } from './tourEvents';

const MAX_SEEDS = 90;
const CAM_POS: [number, number, number] = [0.95, 1.35, 1.2];
const CAM_TARGET: [number, number, number] = [0, 0.03, 0.02];
const TOUR_BASE_FOV = 34;

/**
 * Initial lens fit for the tour stage. Portrait: widen FOV so the board
 * reads above the bottom info card. Does not lock camera position — OrbitControls
 * let the user drag/rotate/zoom when the card still covers the board.
 */
function TourFraming() {
  const camera = useThree((s) => s.camera as THREE.PerspectiveCamera);
  const size = useThree((s) => s.size);
  const invalidate = useThree((s) => s.invalidate);
  const lastAspect = useRef<number | null>(null);

  useLayoutEffect(() => {
    const aspect = size.width / Math.max(1, size.height);
    if (lastAspect.current !== null && Math.abs(aspect - lastAspect.current) < 0.02) {
      return;
    }
    lastAspect.current = aspect;

    const need = THREE.MathUtils.clamp(1.28 / aspect, 1, 2.25);
    const halfBase = Math.tan(THREE.MathUtils.degToRad(TOUR_BASE_FOV / 2));
    camera.fov = Math.min(
      2 * THREE.MathUtils.radToDeg(Math.atan(halfBase * need)),
      66,
    );
    // Mild upward bias only — free orbit can reframe past the card.
    if (aspect < 1) {
      camera.setViewOffset(
        size.width,
        size.height,
        0,
        size.height * 0.1,
        size.width,
        size.height,
      );
    } else {
      camera.clearViewOffset();
    }
    camera.updateProjectionMatrix();
    invalidate();
  }, [camera, size, invalidate]);

  return null;
}

export type TourHighlight =
  | { kind: 'none' }
  | { kind: 'pits'; pits: number[]; color?: string }
  | { kind: 'rows'; south?: boolean; north?: boolean };

/** Scripted sowing loop for a tour step. */
export type TourDemo = {
  /** Board before the demo move. */
  initial: number[];
  /** Optional engine sowing (loops). */
  move?: { startPit: PitIndex; direction: Direction };
  /** Who is sowing (for score side). */
  toMove?: 'S' | 'N';
  /**
   * Truncate the demo at the first event of this type. Engine sowing always
   * runs until a capture, so teaching steps that come before "capture" in the
   * tour use stopAt: 'saada' to end cleanly without spoiling later steps.
   */
  stopAt?: 'saada';
};

export interface TourBoardProps {
  demo: TourDemo;
  highlight?: TourHighlight;
  labels?: { pit: number; text: string; tone?: 'gold' | 'mute' | 'accent' }[];
  dimOthers?: boolean;
  /** Status line under step (e.g. "Dropping…"). */
  onCaption?: (text: string) => void;
}

function blankState(pits: number[], toMove: 'S' | 'N' = 'S'): GameState {
  const board = pits.reduce((a, b) => a + b, 0);
  return {
    pits: pits.slice(),
    score: { S: 0, N: 0, E: 0 },
    toMove,
    sowingsUsedThisTurn: 0,
    protectedMask: Array(14).fill(false),
    resigned: null,
    initialTotal: board,
    config: { ...DEFAULT_CONFIG },
    quietTurns: 0,
    openingComplete: true,
    roundIndex: 0,
    bank: { S: 0, N: 0, E: 0 },
    seriesOver: false,
  };
}

function BoardMesh() {
  const { scene } = useGLTF(BOARD_URL);
  const maps = useBoardMaterialMaps();
  const root = useMemo(() => getStudioBoardRoot(scene, maps), [scene, maps]);
  return <primitive object={root} />;
}

function SeedInstances({ pits }: { pits: number[] }) {
  const { scene } = useGLTF(SEED_URL);
  const maps = useBoardMaterialMaps();
  const geometry = useMemo(() => extractSeedGeometry(scene), [scene]);
  const material = useMemo(() => getSharedSeedMaterial(maps.seed), [maps.seed]);
  const meshRef = useRef<THREE.InstancedMesh>(null);
  const dummy = useMemo(() => new THREE.Object3D(), []);
  const signature = pits.join(',');
  const { invalidate } = useThree();

  useLayoutEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;
    let n = 0;
    for (let i = 0; i < 14; i++) {
      const count = Math.min(pits[i] ?? 0, 12);
      const [px, py, pz] = pitPosition(i);
      const r = PITS[i]?.radius ?? BOARD_META.pitRadius;
      for (const o of seedOffsets(count, r)) {
        if (n >= MAX_SEEDS) break;
        dummy.position.set(px + o[0], py + o[1], pz + o[2]);
        dummy.scale.setScalar(1);
        dummy.rotation.set(0, (n * 0.7) % Math.PI, 0);
        dummy.updateMatrix();
        mesh.setMatrixAt(n, dummy.matrix);
        n++;
      }
    }
    mesh.count = n;
    mesh.instanceMatrix.needsUpdate = true;
    invalidate();
  }, [signature, pits, dummy, invalidate]);

  return (
    <instancedMesh
      ref={meshRef}
      args={[geometry, material, MAX_SEEDS]}
      castShadow
      receiveShadow={false}
      frustumCulled={false}
    />
  );
}

/**
 * Tour flyer — same hop contract as BlenderBoard play hops:
 * useFrame + hopPoint arc, gold ribbon, in-bowl land jitter, pop scale/spin.
 * (react-spring looked softer/floatier than live play.)
 */
function FlyingBead({
  flight,
  onFlightDone,
}: {
  flight: Flight | null;
  onFlightDone: () => void;
}) {
  const { scene } = useGLTF(SEED_URL);
  const maps = useBoardMaterialMaps();
  const geometry = useMemo(() => extractSeedGeometry(scene), [scene]);
  const material = useMemo(() => getSharedSeedMaterial(maps.seed), [maps.seed]);
  const meshRef = useRef<THREE.Mesh>(null);
  const invalidate = useThree((s) => s.invalidate);
  const doneRef = useRef(onFlightDone);
  doneRef.current = onFlightDone;
  const finishedId = useRef(0);

  const hop = useRef({
    id: 0,
    from: [0, HOP_REST_Y, 0] as Vec3,
    to: [0, HOP_REST_Y, 0] as Vec3,
    lift: 0,
    skew: 1,
    spin0: 0,
    spin1: 0,
    start: 0,
    dur: 280,
    live: false,
  });

  // Gold arc ribbon — same visual cue as the play board toss.
  const arcLine = useMemo(() => {
    const positions = new Float32Array((HOP_ARC_SEGMENTS + 1) * 3);
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const mat = new THREE.LineBasicMaterial({
      color: new THREE.Color('#f0d9a0'),
      transparent: true,
      opacity: 0.75,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const line = new THREE.Line(geom, mat);
    line.frustumCulled = false;
    line.visible = false;
    line.renderOrder = 2;
    return line;
  }, []);

  useEffect(() => {
    const h = hop.current;
    if (!flight) {
      h.live = false;
      finishedId.current = 0;
      invalidate();
      return;
    }
    h.id = flight.id;
    h.from = flight.from;
    h.to = flight.to;
    h.lift = flight.lift;
    h.skew = flight.skew;
    h.spin0 = Math.random() * Math.PI * 2;
    h.spin1 = h.spin0 + (Math.random() * 0.9 + 0.55) * Math.PI;
    h.start = performance.now();
    h.dur = Math.max(1, flight.dur);
    h.live = true;
    finishedId.current = 0;
    invalidate();
  }, [flight, invalidate]);

  useFrame(() => {
    const mesh = meshRef.current;
    const arc = arcLine;
    const h = hop.current;
    if (!mesh) return;

    if (!h.live) {
      mesh.visible = false;
      arc.visible = false;
      return;
    }

    const elapsed = performance.now() - h.start;
    const t = Math.min(1, Math.max(0, h.dur > 0 ? elapsed / h.dur : 1));
    const p = hopPoint(h.from, h.to, t, h.lift, h.skew);
    mesh.position.set(p[0], p[1], p[2]);
    mesh.rotation.y = h.spin0 + (h.spin1 - h.spin0) * t;
    // Same pop-in / settle scale as BlenderBoard FlyingSeed
    const scaleIn = Math.min(1, t * 8 + (h.lift === 0 ? 1 : 0));
    const scaleOut = t > 0.92 && h.lift > 0 ? 1 - (t - 0.92) * 0.35 : 1;
    mesh.scale.setScalar(
      Math.max(0.05, scaleIn * scaleOut * 1.22 * FLYER_SCALE_BOOST),
    );
    mesh.visible = true;

    if (h.lift > 0.001) {
      const pos = arc.geometry.getAttribute('position') as THREE.BufferAttribute;
      for (let i = 0; i <= HOP_ARC_SEGMENTS; i++) {
        const u = (i / HOP_ARC_SEGMENTS) * t;
        const q = hopPoint(h.from, h.to, u, h.lift, h.skew);
        pos.setXYZ(i, q[0], q[1], q[2]);
      }
      pos.needsUpdate = true;
      arc.geometry.setDrawRange(0, Math.max(2, Math.floor(t * HOP_ARC_SEGMENTS) + 1));
      (arc.material as THREE.LineBasicMaterial).opacity =
        0.2 + 0.65 * Math.sin(Math.PI * Math.min(1, t * 1.15));
      arc.visible = t > 0.02 && t < 0.98;
    } else {
      arc.visible = false;
    }

    if (t < 1) {
      invalidate();
    } else if (finishedId.current !== h.id) {
      // Resolve at hop end — director lands the pit count on the next tick
      // (same order as play: hop finishes, then display count updates).
      finishedId.current = h.id;
      doneRef.current();
      invalidate();
    }
  });

  return (
    <>
      <mesh
        ref={meshRef}
        geometry={geometry}
        material={material}
        castShadow={false}
        frustumCulled={false}
        visible={false}
        renderOrder={3}
      />
      <primitive object={arcLine} />
    </>
  );
}

function highlightSet(h: TourHighlight | undefined): Set<number> {
  const s = new Set<number>();
  if (!h || h.kind === 'none') return s;
  if (h.kind === 'pits') {
    for (const p of h.pits) s.add(p);
    return s;
  }
  if (h.south) for (let i = 0; i < 7; i++) s.add(i);
  if (h.north) for (let i = 7; i < 14; i++) s.add(i);
  return s;
}

function highlightColor(h: TourHighlight | undefined): string {
  if (h && h.kind === 'pits' && h.color) return h.color;
  return '#e0c989';
}

function PitDecor({
  index,
  count,
  lit,
  color,
  dim,
  label,
  pulse,
}: {
  index: number;
  count: number;
  lit: boolean;
  color: string;
  dim: boolean;
  label?: { text: string; tone?: 'gold' | 'mute' | 'accent' };
  pulse?: boolean;
}) {
  const [x, y, z] = pitSurfacePosition(index);
  const r = PITS[index]?.radius ?? BOARD_META.pitRadius;
  const { invalidate } = useThree();

  const pulseSpring = useSpring({
    from: { pulse: 1 },
    to: { pulse: pulse || lit ? 1.05 : 1 },
    loop: pulse ? { reverse: true } : false,
    config: { tension: 140, friction: 22 },
    onChange: () => invalidate(),
  });

  const ringSpring = useSpring({
    opacity: lit ? 0.4 : 0,
    config: { tension: 200, friction: 24 },
    onChange: () => invalidate(),
  });

  const tone =
    label?.tone === 'accent'
      ? 'accent'
      : label?.tone === 'mute'
        ? 'mute'
        : lit
          ? 'hot'
          : 'default';

  return (
    <group position={[x, y, z]}>
      <animated.mesh
        rotation={[-Math.PI / 2, 0, 0]}
        position={[0, 0.001, 0]}
        scale={pulseSpring.pulse}
      >
        <ringGeometry args={[r * 0.7, r * 1.22, 40]} />
        <animated.meshBasicMaterial
          color={color}
          transparent
          opacity={ringSpring.opacity.to((o) => o * 0.4)}
          side={THREE.DoubleSide}
          depthWrite={false}
          depthTest={false}
          blending={THREE.AdditiveBlending}
        />
      </animated.mesh>
      <animated.mesh
        rotation={[-Math.PI / 2, 0, 0]}
        position={[0, 0.002, 0]}
        scale={pulseSpring.pulse.to((p) => 1 + (p - 1) * 0.3)}
      >
        <ringGeometry args={[r * 0.82, r * 1.06, 40]} />
        <animated.meshBasicMaterial
          color={color}
          transparent
          opacity={ringSpring.opacity}
          side={THREE.DoubleSide}
          depthWrite={false}
          depthTest={false}
        />
      </animated.mesh>
      <AnimatedPitCount
        count={count}
        pitId={INDEX_TO_LABEL[index] ?? undefined}
        caption={label?.text}
        dim={dim && !lit}
        tone={tone as 'default' | 'hot' | 'mute' | 'accent'}
        position={[0, 0.024, 0]}
        distanceFactor={1.2}
      />
    </group>
  );
}

/** Bowl-center rest point (Three Y-up), matching play board HOP_REST_Y. */
function pitHopOrigin(i: number): Vec3 {
  const [x, y, z] = pitPosition(i);
  return [x, y + HOP_REST_Y, z];
}

/** Random land inside the bowl — same jitter as BlenderBoard FlyingSeed. */
function pitHopDest(i: number): Vec3 {
  const [x, y, z] = pitPosition(i);
  const r = PITS[i]?.radius ?? BOARD_META.pitRadius;
  const ja = Math.random() * Math.PI * 2;
  const jr = Math.sqrt(Math.random()) * r * 0.35;
  return [
    x + Math.cos(ja) * jr,
    y + HOP_REST_Y,
    z + Math.sin(ja) * jr,
  ];
}

type Flight = {
  id: number;
  from: Vec3;
  to: Vec3;
  dur: number;
  lift: number;
  skew: number;
};

type Phase =
  | { kind: 'idle' }
  | { kind: 'wait'; until: number; next: () => void }
  | { kind: 'fly'; onDone: () => void; deadline: number }
  | { kind: 'hold'; until: number };

/**
 * Plays engine sowing events as board updates + flying beads, then loops.
 */
function DemoDirector({
  demo,
  onPits,
  onCaption,
  onHighlight,
  pace,
}: {
  demo: TourDemo;
  onPits: (p: number[]) => void;
  onCaption: (s: string) => void;
  onHighlight: (pits: number[]) => void;
  pace: EventPace;
}) {
  const [flight, setFlight] = useState<Flight | null>(null);
  const phase = useRef<Phase>({ kind: 'idle' });
  const gen = useRef(0);
  const flightId = useRef(0);
  const pitsRef = useRef(demo.initial.slice());
  const paceRef = useRef(pace);
  paceRef.current = pace;
  // Stable refs so useFrame always sees the latest loop control.
  const startLoopRef = useRef<() => void>(() => {});

  /** One-shot phase transitions — never re-fire the same wait/hold/fly. */
  const clearPhase = () => {
    phase.current = { kind: 'idle' };
  };

  /** Abort sleep/fly so a cancelled gen can exit awaits (then gen-check). */
  const abortPhase = () => {
    const p = phase.current;
    clearPhase();
    setFlight(null);
    if (p.kind === 'wait') p.next();
    else if (p.kind === 'fly') p.onDone();
  };

  // Drive wait/hold timers; flight completion is via FlyingBead (with deadline fallback).
  useFrame((state) => {
    state.invalidate();
    const now = performance.now();
    const p = phase.current;

    if (p.kind === 'wait' && now >= p.until) {
      clearPhase();
      p.next();
      return;
    }
    if (p.kind === 'fly' && now >= p.deadline) {
      // Safety: if the mesh never reported done (tab freeze / missed frame), unblock.
      clearPhase();
      p.onDone();
      return;
    }
    if (p.kind === 'hold' && now >= p.until) {
      // Must clear before startLoop — otherwise every frame spawns a new run.
      clearPhase();
      startLoopRef.current();
    }
  });

  const setPits = (next: number[]) => {
    pitsRef.current = next.slice();
    onPits(next.slice());
  };

  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      phase.current = {
        kind: 'wait',
        until: performance.now() + Math.max(0, ms),
        next: () => resolve(),
      };
    });

  const startFlight = (
    from: Vec3,
    to: Vec3,
    dur: number,
    lift: number,
    skew = randomHopSkew(),
  ) =>
    new Promise<void>((resolve) => {
      const id = ++flightId.current;
      const safeDur = Math.max(1, dur);
      const f: Flight = { id, from, to, dur: safeDur, lift, skew };
      setFlight(f);
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        if (flightId.current === id) setFlight(null);
        resolve();
      };
      phase.current = {
        kind: 'fly',
        // Grace past hopDuration so normal completion wins; deadline is a backstop.
        deadline: performance.now() + safeDur + 200,
        onDone: () => {
          if (flightId.current !== id) return;
          clearPhase();
          finish();
        },
      };
    });

  const onFlightDone = () => {
    const p = phase.current;
    if (p.kind === 'fly') p.onDone();
  };

  /**
   * Pit-to-pit hop — same duration/lift/landing as live BlenderBoard play.
   * Uses play-speed hop budget so the toss matches the game; the director
   * still holds the extra tour pacing as settle after the land.
   */
  const fly = (fromPit: number, toPit: number, hopBudgetMs: number) => {
    const dur = hopDurationMs(hopBudgetMs);
    if (dur <= 0) return Promise.resolve();
    return startFlight(
      pitHopOrigin(fromPit),
      pitHopDest(toPit),
      dur,
      randomHopLift(HOP_ARC_BOOST),
    );
  };

  const flyToScore = (fromPit: number, side: 'S' | 'N', captureMs: number) => {
    const from = pitHopDest(fromPit);
    const to: Vec3 = [
      side === 'S' ? 0.55 : -0.55,
      0.12,
      side === 'S' ? 0.28 : -0.22,
    ];
    const dur = captureFlightDurationMs(captureMs);
    if (dur <= 0) return Promise.resolve();
    return startFlight(from, to, dur, randomHopLift(HOP_ARC_BOOST) * 1.05);
  };

  async function playEvents(
    events: MoveEvent[],
    toMove: 'S' | 'N',
    myGen: number,
  ) {
    let handPos = 0;
    // Play-speed hop budget (matches live board). Tour P.* stays slower for
    // holds so teaching captions remain readable.
    const settings = useGameStore.getState().settings;
    const reducedMotion = prefersReducedMotion(settings);
    const playDrop = dropMsForSpeed(settings.travelSpeed, reducedMotion);
    const playCapture = eventPaceFromDrop(playDrop).capture;

    for (const e of events) {
      if (gen.current !== myGen) return;
      const P = paceRef.current;
      // Reduced motion: no flying beads; each event lands as a readable
      // static beat instead of an instant blur.
      const reduced = P.drop === 0 || playDrop === 0;
      const beat = (ms: number) => sleep(reduced ? 420 : ms);
      switch (e.type) {
        case 'pickup': {
          onCaption(`Pick up ${e.count}`);
          onHighlight([e.pit]);
          sfx.pickup(e.pit);
          const pits = pitsRef.current.slice();
          pits[e.pit] = 0;
          setPits(pits);
          handPos = e.pit;
          await beat(P.pickup);
          break;
        }
        case 'drop': {
          onCaption(e.remainingInHand > 0 ? `Drop · ${e.remainingInHand} in hand` : 'Last drop');
          onHighlight([e.pit]);
          // Hop uses play-speed duration; land count after hop; tour settle fills
          // the rest of P.drop so total teaching pace stays clear.
          sfx.drop(e.pit);
          const hopMs = hopDurationMs(playDrop);
          if (!reduced) await fly(handPos, e.pit, playDrop);
          const pits = pitsRef.current.slice();
          pits[e.pit] = (pits[e.pit] ?? 0) + 1;
          setPits(pits);
          handPos = e.pit;
          const settle = reduced
            ? 420
            : Math.max(0, P.drop - hopMs);
          if (settle > 0) await beat(settle);
          break;
        }
        case 'continue': {
          onCaption(`Continue · pick up ${e.count}`);
          onHighlight([e.pit]);
          sfx.relay(e.pit);
          const pits = pitsRef.current.slice();
          pits[e.pit] = 0;
          setPits(pits);
          handPos = e.pit;
          await beat(P.continue);
          break;
        }
        case 'saada': {
          onCaption('Saada · next pit empty');
          onHighlight([e.emptyPit]);
          sfx.saada(e.emptyPit);
          await beat(P.saada);
          break;
        }
        case 'capture': {
          const total = e.amounts.reduce((a, b) => a + b, 0);
          onCaption(total > 0 ? `Capture +${total}` : 'Empty capture');
          onHighlight([...e.pits]);
          if (total > 0) sfx.capture([...e.pits], total);
          // Share play-speed capture budget across sequential teaching flights
          // (live play flies them in parallel; tour shows each bowl in turn).
          const flying = e.pits
            .map((pit, i) => ({ pit, amt: e.amounts[i] ?? 0 }))
            .filter((x) => x.amt > 0);
          const capBudget = playCapture > 0 ? playCapture : P.capture;
          const share =
            flying.length > 0
              ? Math.max(1, Math.floor(capBudget / flying.length))
              : capBudget;
          for (const { pit } of flying) {
            if (!reduced) await flyToScore(pit, toMove, share);
            const pits = pitsRef.current.slice();
            pits[pit] = 0;
            setPits(pits);
          }
          // Clear both even if 0
          const pits = pitsRef.current.slice();
          for (const pit of e.pits) pits[pit] = 0;
          setPits(pits);
          // Residual settle uses tour capture pacing so the lesson can breathe.
          const used = flying.length * captureFlightDurationMs(share);
          const settle = Math.max(0, P.capture - used);
          if (settle > 0 || reduced) {
            await beat(reduced ? Math.max(40, P.capture * 0.35) : settle || 40);
          }
          break;
        }
        default:
          break;
      }
    }
  }

  async function runOnce(myGen: number) {
    const initial = demo.initial.slice();
    setPits(initial);
    onHighlight([]);
    onCaption('');
    await sleep(Math.max(200, paceRef.current.pickup));
    if (gen.current !== myGen) return;

    if (!demo.move) {
      // Idle showcase — brief pause then soft re-hold
      onCaption('Fourteen pits · coral beads');
      phase.current = { kind: 'hold', until: performance.now() + Math.max(2500, paceRef.current.hold * 3) };
      return;
    }

    const toMove = demo.toMove ?? (demo.move.startPit < 7 ? 'S' : 'N');
    const state = blankState(initial, toMove);
    let events: MoveEvent[];
    try {
      ({ events } = executeSowing(state, demo.move.startPit, demo.move.direction));
    } catch {
      onCaption('Demo unavailable');
      phase.current = { kind: 'hold', until: performance.now() + 2000 };
      return;
    }

    if (demo.stopAt === 'saada') {
      events = truncateTourEvents(events, 'saada');
    }

    onCaption('Sowing…');
    await playEvents(events, toMove, myGen);
    if (gen.current !== myGen) return;
    onCaption('Replay…');
    await sleep(paceRef.current.hold);
    if (gen.current !== myGen) return;
    phase.current = { kind: 'hold', until: performance.now() + paceRef.current.reset };
  }

  function startLoop() {
    // Cancel any in-flight sleep/hop from the previous cycle before bumping gen.
    abortPhase();
    const my = ++gen.current;
    void runOnce(my);
  }
  startLoopRef.current = startLoop;

  useEffect(() => {
    pitsRef.current = demo.initial.slice();
    onPits(demo.initial.slice());
    startLoop();
    return () => {
      gen.current += 1;
      abortPhase();
    };
    // Restart when the coach step’s demo identity changes (key also remounts us).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [demo]);

  return <FlyingBead flight={flight} onFlightDone={onFlightDone} />;
}

function TourScene({
  demo,
  highlight,
  labels,
  dimOthers,
  onCaption,
}: TourBoardProps) {
  const [pits, setPits] = useState(() => demo.initial.slice());
  const [liveHighlight, setLiveHighlight] = useState<number[]>([]);
  const travelSpeed = useGameStore((s) => s.settings.travelSpeed);
  const reducedOverride = useGameStore((s) => s.settings.reducedMotionOverride);

  const pace = useMemo(() => {
    const reduced =
      reducedOverride === 'always' ||
      (reducedOverride === 'auto' &&
        typeof window !== 'undefined' &&
        window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    return tourPaceFromSpeed(travelSpeed ?? TRAVEL_SPEED_DEFAULT, reduced);
  }, [travelSpeed, reducedOverride]);

  const baseLit = highlightSet(highlight);
  const color = highlightColor(highlight);
  const live = useMemo(() => new Set(liveHighlight), [liveHighlight]);

  const labelByPit = useMemo(() => {
    const m = new Map<number, { text: string; tone?: 'gold' | 'mute' | 'accent' }>();
    for (const l of labels ?? []) m.set(l.pit, l);
    return m;
  }, [labels]);

  // Stable demo ref for director deps
  const demoKey = useMemo(
    () =>
      JSON.stringify({
        i: demo.initial,
        m: demo.move,
        t: demo.toMove,
      }),
    [demo],
  );

  return (
    <>
      <RenderWake frames={30} />
      <TourFraming />
      <color attach="background" args={['#1a120c']} />
      <fog attach="fog" args={['#1a120c', 4, 12]} />
      <StudioLights quality="hero" envIntensity={0.1} />
      <Suspense fallback={null}>
        <HomeVeranda floorSize={6.5} dynamicLights={false} />
      </Suspense>
      <group>
        <BoardMesh />
        <SeedInstances pits={pits} />
        <RowInitialMarker row="A" position={[-0.62, 0.06, -0.09]} subtitle="North · far" />
        <RowInitialMarker row="B" position={[-0.62, 0.06, 0.09]} subtitle="South · near" />
        <DemoDirector
          key={demoKey}
          demo={demo}
          pace={pace}
          onPits={setPits}
          onCaption={(t) => onCaption?.(t)}
          onHighlight={setLiveHighlight}
        />
        {PITS.map((p) => {
          const idx = p.index;
          const isLit =
            live.has(idx) || (baseLit.size > 0 && live.size === 0 && baseLit.has(idx));
          const dim = Boolean(
            dimOthers &&
              ((live.size > 0 && !live.has(idx)) ||
                (live.size === 0 && baseLit.size > 0 && !baseLit.has(idx))),
          );
          return (
            <PitDecor
              key={idx}
              index={idx}
              count={pits[idx] ?? 0}
              lit={isLit}
              color={live.has(idx) ? '#f0d9a0' : color}
              dim={dim}
              label={labelByPit.get(idx)}
              pulse={live.has(idx)}
            />
          );
        })}
      </group>
      <GroundContactShadow
        position={[0, 0, 0]}
        opacity={0.36}
        scale={3.2}
        blur={2.6}
        far={1.2}
        color="#1a1008"
        resolution={256}
        frames={Infinity}
      />
      {/* Drag to orbit / pan when the bottom info card covers the board. */}
      <OrbitControls
        makeDefault
        enablePan
        enableDamping
        dampingFactor={0.08}
        minDistance={0.85}
        maxDistance={4.8}
        minPolarAngle={0.22}
        maxPolarAngle={1.35}
        target={CAM_TARGET}
        // Keep the board from sliding too far under the HUD card.
        minAzimuthAngle={-Math.PI * 0.85}
        maxAzimuthAngle={Math.PI * 0.85}
        touches={{
          ONE: THREE.TOUCH.ROTATE,
          TWO: THREE.TOUCH.DOLLY_PAN,
        }}
      />
    </>
  );
}

function TourFallback() {
  return (
    <div className="home-hero-fallback" aria-hidden>
      <div className="home-hero-fallback-board" />
    </div>
  );
}

/** Tour stage: live board + looping bead-travel demos. */
export function TourBoard(props: TourBoardProps) {
  return (
    <div className="tour-board-3d" aria-hidden>
      <Suspense fallback={<TourFallback />}>
        <Canvas
          shadows={false}
          dpr={HERO_DPR}
          frameloop="always"
          gl={{
            antialias: true,
            alpha: false,
            powerPreference: 'default',
            failIfMajorPerformanceCaveat: false,
            toneMapping: THREE.ACESFilmicToneMapping,
            toneMappingExposure: 0.95,
            outputColorSpace: THREE.SRGBColorSpace,
          }}
          camera={{ position: CAM_POS, fov: 34, near: 0.05, far: 24 }}
          style={{
            width: '100%',
            height: '100%',
            display: 'block',
            touchAction: 'none',
            // Canvas must receive drags; HUD card uses its own hit targets.
            pointerEvents: 'auto',
          }}
          onCreated={({ camera, gl }) => {
            camera.lookAt(...CAM_TARGET);
            gl.setClearColor(0x1a120c, 1);
            gl.shadowMap.enabled = false;
            gl.domElement.addEventListener('webglcontextlost', (e) => e.preventDefault());
          }}
        >
          <TourScene {...props} />
        </Canvas>
      </Suspense>
    </div>
  );
}

preloadBoardAssets();
