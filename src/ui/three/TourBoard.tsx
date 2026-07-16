import {
  Suspense,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { useGLTF } from '@react-three/drei';
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
import { HERO_DPR } from './quality';
import { StudioLights } from './StudioLights';

const MAX_SEEDS = 90;
const CAM_POS: [number, number, number] = [0.95, 1.35, 1.2];
const CAM_TARGET: [number, number, number] = [0, 0.03, 0.02];

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

/** Single bead that flies between pits (or to score space) via react-spring. */
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
  const { invalidate } = useThree();
  const doneRef = useRef(onFlightDone);
  doneRef.current = onFlightDone;

  const from = flight?.from ?? new THREE.Vector3();
  const to = flight?.to ?? new THREE.Vector3();
  const lift = flight?.lift ?? 0.05;

  const spring = useSpring({
    from: { t: 0 },
    to: { t: 1 },
    config: {
      duration: Math.max(40, flight?.dur ?? 200),
      easing: (x: number) => x * x * (3 - 2 * x),
    },
    onChange: () => invalidate(),
    onRest: () => {
      doneRef.current();
    },
  });

  if (!flight) return null;

  const position = spring.t.to((t: number) => {
    const x = from.x + (to.x - from.x) * t;
    const z = from.z + (to.z - from.z) * t;
    const baseY = from.y + (to.y - from.y) * t;
    const arc = Math.sin(Math.PI * t) * lift;
    return [x, baseY + arc, z] as [number, number, number];
  });

  return (
    <animated.mesh
      geometry={geometry}
      material={material}
      castShadow
      frustumCulled={false}
      position={position as unknown as [number, number, number]}
      rotation-y={spring.t.to((t: number) => t * Math.PI * 1.4)}
      scale={spring.t.to((t: number) => 1.05 + t * 0.12)}
    />
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

function pitVec(i: number, yLift = 0): THREE.Vector3 {
  const [x, y, z] = pitPosition(i);
  return new THREE.Vector3(x, y + 0.012 + yLift, z);
}

type Flight = {
  id: number;
  from: THREE.Vector3;
  to: THREE.Vector3;
  dur: number;
  lift: number;
};

type Phase =
  | { kind: 'idle' }
  | { kind: 'wait'; until: number; next: () => void }
  | { kind: 'fly'; onDone: () => void }
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

  // Drive wait/hold timers; flight completion is via spring onRest
  useFrame((state) => {
    state.invalidate();
    const now = performance.now();
    const p = phase.current;

    if (p.kind === 'wait' && now >= p.until) {
      p.next();
      return;
    }
    if (p.kind === 'hold' && now >= p.until) {
      startLoop();
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
        until: performance.now() + ms,
        next: () => resolve(),
      };
    });

  const startFlight = (from: THREE.Vector3, to: THREE.Vector3, dur: number, lift: number) =>
    new Promise<void>((resolve) => {
      const id = ++flightId.current;
      const f: Flight = { id, from, to, dur, lift };
      setFlight(f);
      phase.current = {
        kind: 'fly',
        onDone: () => {
          if (flightId.current !== id) return;
          setFlight(null);
          resolve();
        },
      };
    });

  const onFlightDone = () => {
    const p = phase.current;
    if (p.kind === 'fly') p.onDone();
  };

  const fly = (fromPit: number, toPit: number, dur: number, lift = 0.048) =>
    startFlight(pitVec(fromPit, 0.01), pitVec(toPit, 0.01), dur, lift);

  const flyToScore = (fromPit: number, side: 'S' | 'N', dur: number) => {
    const from = pitVec(fromPit, 0.01);
    const to = new THREE.Vector3(
      side === 'S' ? 0.55 : -0.55,
      0.12,
      side === 'S' ? 0.28 : -0.22,
    );
    return startFlight(from, to, dur, 0.08);
  };

  async function playEvents(
    events: MoveEvent[],
    toMove: 'S' | 'N',
    myGen: number,
  ) {
    let handPos = 0;
    for (const e of events) {
      if (gen.current !== myGen) return;
      const P = paceRef.current;
      // Reduced motion: no flying beads; each event lands as a readable
      // static beat instead of an instant blur.
      const reduced = P.drop === 0;
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
          if (!reduced) await fly(handPos, e.pit, Math.max(40, P.drop));
          sfx.drop(e.pit);
          const pits = pitsRef.current.slice();
          pits[e.pit] = (pits[e.pit] ?? 0) + 1;
          setPits(pits);
          handPos = e.pit;
          await beat(Math.max(16, Math.round(P.drop * 0.12)));
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
          for (let i = 0; i < e.pits.length; i++) {
            const pit = e.pits[i]!;
            const amt = e.amounts[i] ?? 0;
            if (amt <= 0) continue;
            // One flying bead stands for the pile
            if (!reduced) await flyToScore(pit, toMove, Math.max(80, P.capture * 0.55));
            const pits = pitsRef.current.slice();
            pits[pit] = 0;
            setPits(pits);
          }
          // Clear both even if 0
          const pits = pitsRef.current.slice();
          for (const pit of e.pits) pits[pit] = 0;
          setPits(pits);
          await beat(Math.max(40, P.capture * 0.35));
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

    // Engine sowing always runs to a capture; teaching steps that come before
    // the capture lesson cut the demo off at the first saada.
    if (demo.stopAt === 'saada') {
      const cut = events.findIndex((e) => e.type === demo.stopAt);
      if (cut >= 0) events = events.slice(0, cut);
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
    const my = ++gen.current;
    void runOnce(my);
  }

  useEffect(() => {
    gen.current += 1;
    pitsRef.current = demo.initial.slice();
    onPits(demo.initial.slice());
    startLoop();
    return () => {
      gen.current += 1;
      phase.current = { kind: 'idle' };
      setFlight(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- restart only when demo identity changes
  }, [demo]);

return <FlyingBead key={flight?.id ?? 'idle'} flight={flight} onFlightDone={onFlightDone} />;
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
          style={{ width: '100%', height: '100%', display: 'block' }}
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
