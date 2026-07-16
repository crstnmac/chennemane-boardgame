import {
  Component,
  memo,
  Suspense,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  type ReactNode,
} from 'react';
import { Canvas, useThree } from '@react-three/fiber';
import { Html, OrbitControls, useGLTF } from '@react-three/drei';
import { animated, useSpring } from '@react-spring/three';
import * as THREE from 'three';
import { getLegalMoves, INDEX_TO_LABEL, type PitIndex } from '../../engine';
import { useGameStore, type TurnPhase } from '../../session/store';
import { AnimatedPitCount, RowInitialMarker } from './AnimatedPitCount';
import { BOARD_URL, SEED_URL } from './assetUrls';
import { useBoardMaterialMaps } from './boardMaterialMaps';
import { CoconutStores } from './CoconutStores';
import { BOARD_META, PITS, pitPosition, pitSurfacePosition, seedOffsets } from './layout';
import { RenderWake } from './RenderWake';
import {
  extractSeedGeometry,
  getSharedSeedMaterial,
  getStudioBoardRoot,
  preloadBoardAssets,
} from './sharedAssets';
import { GroundContactShadow } from './GroundContactShadow';
import { HomeVeranda } from './HomeVeranda';
import { BOARD_DPR, CONTACT_SHADOW_RESOLUTION, IS_LOW_POWER } from './quality';
import { StudioLights, preloadPlayEnvironment } from './StudioLights';

const MAX_SEEDS = 96;

// Play camera: elevated south view — pits readable, rings not edge-on
const CAM_POS: [number, number, number] = [0, 1.42, 1.05];
const CAM_TARGET: [number, number, number] = [0, 0.02, 0.02];

const BASE_FOV = 42;

/**
 * The board is wide (14 pits in two rows), framed for landscape. On narrow
 * portrait viewports the horizontal FOV shrinks and crops the end pits +
 * coconut shells. Pull the camera back only a little — any farther and it
 * exits the room through the ceiling and leaves the lamp light — then widen
 * the lens for the rest of the required coverage.
 *
 * Runs only when the viewport SHAPE changes. R3F publishes a fresh `size`
 * object on any re-measure (scroll, URL-bar collapse, spurious observer
 * callbacks), so reframing unconditionally would stomp the user's pinch-zoom
 * mid-game. On a real aspect change the current zoom is rescaled relative to
 * the previous baseline, never reset.
 */
function ResponsiveFraming() {
  const camera = useThree((s) => s.camera as THREE.PerspectiveCamera);
  const size = useThree((s) => s.size);
  const invalidate = useThree((s) => s.invalidate);
  const target = useMemo(() => new THREE.Vector3(...CAM_TARGET), []);
  const applied = useRef<{ aspect: number; distScale: number } | null>(null);

  useLayoutEffect(() => {
    const aspect = size.width / Math.max(1, size.height);
    const prev = applied.current;
    if (prev && Math.abs(aspect - prev.aspect) < 0.02) return;

    // Cover board + coconut shells (±0.52 world X). Tighter than the original
    // 1.35 fill-the-floor framing, but not so tight that portrait crops shells.
    const need = THREE.MathUtils.clamp(1.28 / aspect, 1, 2.25);
    const distScale = Math.min(need, 1.2);
    const offset = camera.position.clone().sub(target);
    if (offset.lengthSq() < 1e-6) offset.set(...CAM_POS).sub(target);
    const zoomRatio = distScale / (prev?.distScale ?? 1);
    offset.setLength(
      THREE.MathUtils.clamp(offset.length() * zoomRatio, 0.95, 4.5),
    );
    camera.position.copy(target).add(offset);

    // Portrait: bias the view upward — the bottom status bar covers more of
    // the screen than the top HUD, so the visual center sits above middle.
    if (aspect < 1) {
      camera.setViewOffset(
        size.width,
        size.height,
        0,
        size.height * 0.035,
        size.width,
        size.height,
      );
    } else {
      camera.clearViewOffset();
    }

    const fovScale = need / distScale;
    const halfBase = Math.tan(THREE.MathUtils.degToRad(BASE_FOV / 2));
    camera.fov = Math.min(
      2 * THREE.MathUtils.radToDeg(Math.atan(halfBase * fovScale)),
      68,
    );
    camera.updateProjectionMatrix();
    camera.lookAt(target);
    applied.current = { aspect, distScale };
    invalidate();
  }, [camera, size, target, invalidate]);

  return null;
}

function isAiPhase(p: TurnPhase) {
  return p === 'ai-thinking' || p === 'ai-preview' || p === 'ai-playing';
}

function BoardMesh() {
  const { scene } = useGLTF(BOARD_URL);
  const maps = useBoardMaterialMaps();
  const root = useMemo(() => getStudioBoardRoot(scene, maps), [scene, maps]);
  return <primitive object={root} />;
}

const SeedInstances = memo(function SeedInstances({
  displayPits,
}: {
  displayPits: number[];
}) {
  const { scene } = useGLTF(SEED_URL);
  const maps = useBoardMaterialMaps();
  const geometry = useMemo(() => extractSeedGeometry(scene), [scene]);
  const material = useMemo(() => getSharedSeedMaterial(maps.seed), [maps.seed]);
  const meshRef = useRef<THREE.InstancedMesh>(null);
  const dummy = useMemo(() => new THREE.Object3D(), []);
  const { invalidate } = useThree();

  const signature = displayPits.join(',');

  useLayoutEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;

    let n = 0;
    for (let i = 0; i < 14; i++) {
      const count = Math.min(displayPits[i] ?? 0, 12);
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
  }, [signature, displayPits, dummy, invalidate]);

  return (
    <instancedMesh
      ref={meshRef}
      args={[geometry, material, MAX_SEEDS]}
      castShadow
      receiveShadow={false}
      frustumCulled={false}
    />
  );
});

/** Baseline height (Three Y) a bead rises to at the top of a hop. */
const HOP_LIFT = 0.105;
/** Bead sits this far above the pit floor when resting/landing. */
const HOP_REST_Y = 0.028;

type Vec3 = [number, number, number];

/** Ken Perlin smootherstep — eased 0→1 with zero velocity at both ends. */
function smoother(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

/**
 * Point along a hop at progress t. Horizontal eases in/out (a carried hand),
 * vertical is a sine arc (the toss). `skew` shifts the apex so the rise and
 * fall aren't perfectly symmetric — reads more like a real throw.
 */
function hopPoint(from: Vec3, to: Vec3, t: number, lift: number, skew: number): Vec3 {
  const e = smoother(t);
  const arc = Math.sin(Math.PI * Math.pow(t, skew)) * lift;
  return [
    from[0] + (to[0] - from[0]) * e,
    from[1] + (to[1] - from[1]) * t + arc,
    from[2] + (to[2] - from[2]) * e,
  ];
}

function FlyingSeed() {
  const highlightPit = useGameStore((s) => s.highlightPit);
  const highlightKind = useGameStore((s) => s.highlightKind);
  const turnPhase = useGameStore((s) => s.turnPhase);
  const { scene } = useGLTF(SEED_URL);
  const maps = useBoardMaterialMaps();
  const geometry = useMemo(() => extractSeedGeometry(scene), [scene]);
  const material = useMemo(() => getSharedSeedMaterial(maps.seed), [maps.seed]);
  const { invalidate } = useThree();

  const active =
    highlightPit !== null &&
    (turnPhase === 'animating' ||
      turnPhase === 'ai-playing' ||
      turnPhase === 'ai-preview');

  // Current hop endpoints + its randomized shape. Each drop tosses from wherever
  // the bead currently is into the next pit, landing at a slightly random spot —
  // like a hand that never places two beads in exactly the same place.
  const fromRef = useRef<Vec3>([0, HOP_REST_Y, 0]);
  const toRef = useRef<Vec3>([0, HOP_REST_Y, 0]);
  const liftRef = useRef(0);
  const skewRef = useRef(1);
  const spinFromRef = useRef(0);
  const spinToRef = useRef(0);

  // `t` drives each hop (0→1); `appear` fades/scales the bead in and out.
  const [spring, api] = useSpring(() => ({
    t: 1,
    appear: 0,
    onChange: () => invalidate(),
  }));

  useEffect(() => {
    if (highlightPit === null) {
      void api.start({ appear: 0, config: { tension: 240, friction: 26 } });
      return;
    }
    const [x, y, z] = pitPosition(highlightPit);
    const r = PITS[highlightPit]?.radius ?? BOARD_META.pitRadius;
    // Land at a random point inside the bowl, not dead center.
    const ja = Math.random() * Math.PI * 2;
    const jr = Math.sqrt(Math.random()) * r * 0.35;
    const dest: Vec3 = [x + Math.cos(ja) * jr, y + HOP_REST_Y, z + Math.sin(ja) * jr];

    // A drop is a real toss between pits; pickup/relay/capture grab in place.
    const isHop = highlightKind === 'drop';

    // Start the new hop from the bead's *current* position so speed changes and
    // interrupted hops never snap — the motion stays continuous.
    const curT = spring.t.get();
    fromRef.current = isHop
      ? hopPoint(fromRef.current, toRef.current, curT, liftRef.current, skewRef.current)
      : dest;
    toRef.current = dest;
    liftRef.current = isHop ? HOP_LIFT * (0.82 + Math.random() * 0.42) : 0;
    skewRef.current = 0.9 + Math.random() * 0.35;
    spinFromRef.current = spinToRef.current;
    spinToRef.current = spinFromRef.current + (Math.random() * 0.8 + 0.6) * Math.PI;

    void api.start({
      from: { t: 0 },
      to: { t: 1 },
      reset: true,
      // Gentle near-critically-damped spring → naturally smooth arc that
      // settles into the pit without overshooting past it.
      config: { tension: 150, friction: 21, mass: 0.85 },
    });
    void api.start({ appear: 1, config: { tension: 300, friction: 22 } });
  }, [highlightPit, highlightKind, api]);

  const position = spring.t.to(
    (t: number) =>
      hopPoint(fromRef.current, toRef.current, t, liftRef.current, skewRef.current) as Vec3,
  );

  return (
    <animated.mesh
      geometry={geometry}
      material={material}
      castShadow
      frustumCulled={false}
      position={position as unknown as [number, number, number]}
      scale={spring.appear.to((a: number) => 0.01 + a * 1.12)}
      rotation-y={spring.t.to(
        (t: number) => spinFromRef.current + (spinToRef.current - spinFromRef.current) * t,
      )}
      visible={active}
    />
  );
}

type HighlightKind =
  | 'none'
  | 'select'
  | 'pickup'
  | 'drop'
  | 'continue'
  | 'saada'
  | 'capture'
  | 'ai';

const COLLECT_KINDS = new Set<HighlightKind>(['pickup', 'continue', 'capture']);

const PitHitTarget = memo(function PitHitTarget({
  index,
  count,
  legal,
  showHint,
  selected,
  highlight,
  highlightKind,
  aiPreview,
  canClick,
  showCount,
  blocked,
  onSelect,
}: {
  index: PitIndex;
  count: number;
  /** Can this pit be chosen right now? */
  legal: boolean;
  /** Show idle legal-move ring (Hints toggle). */
  showHint: boolean;
  selected: boolean;
  highlight: boolean;
  highlightKind: HighlightKind;
  aiPreview: boolean;
  canClick: boolean;
  showCount: boolean;
  /** Multi-round: pit is protected (closed) this round. */
  blocked?: boolean;
  onSelect: (p: PitIndex) => void;
}) {
  const [x, y, z] = pitSurfacePosition(index);
  const r = PITS[index]?.radius ?? BOARD_META.pitRadius;
  const isCollect = highlight && COLLECT_KINDS.has(highlightKind);
  const isSaada = highlight && highlightKind === 'saada';
  const isDrop = highlight && highlightKind === 'drop';
  const { invalidate } = useThree();

  const ringColor = aiPreview
    ? '#9a8fb0'
    : isCollect
      ? '#f0c878'
      : isSaada
        ? '#c8a0e0'
        : selected || highlight
          ? '#e0c989'
          : showHint
            ? '#c9b07a'
            : '#000';

  // Clicks always respect legality; hints only affect idle ring visibility
  const interactive = canClick && legal;
  const downPos = useRef<{ x: number; y: number } | null>(null);

  // Gentle pulse while collecting / AI preview (kept small for visibility)
  const pulseSpring = useSpring({
    from: { pulse: 1 },
    to: { pulse: isCollect ? 1.06 : highlight || aiPreview ? 1.03 : 1 },
    loop: isCollect || aiPreview ? { reverse: true } : false,
    config: { tension: 140, friction: 22 },
    onChange: () => invalidate(),
  });

  const ringSpring = useSpring({
    // Active move feedback always; idle legal rings only when hints on
    ringOpacity:
      highlight || aiPreview || selected ? 0.42 : showHint ? 0.28 : 0,
    fillOpacity: isCollect ? 0.12 : isDrop ? 0.08 : isSaada ? 0.07 : 0,
    fillScale: isCollect ? 1.04 : 1,
    config: { tension: 220, friction: 24 },
    onChange: () => invalidate(),
  });

  const [burstSpring, burstApi] = useSpring(() => ({
    scale: 1,
    opacity: 0,
    config: { tension: 180, friction: 26 },
  }));

  useEffect(() => {
    if (!isCollect) return;
    void burstApi.start({
      from: { scale: 0.9, opacity: 0.22 },
      to: { scale: 1.45, opacity: 0 },
      config: { duration: 380 },
      onChange: () => invalidate(),
    });
  }, [isCollect, highlightKind, index, burstApi, invalidate]);

  const showRings = highlight || aiPreview || selected || showHint;

  return (
    <group position={[x, y, z]}>
      <mesh
        rotation={[-Math.PI / 2, 0, 0]}
        onPointerDown={(e) => {
          if (!interactive) return;
          e.stopPropagation();
          downPos.current = { x: e.clientX, y: e.clientY };
        }}
        onPointerUp={(e) => {
          if (!interactive || !downPos.current) return;
          e.stopPropagation();
          const dx = e.clientX - downPos.current.x;
          const dy = e.clientY - downPos.current.y;
          downPos.current = null;
          if (dx * dx + dy * dy < 100) onSelect(index);
        }}
        onPointerOver={(e) => {
          if (interactive) {
            e.stopPropagation();
            document.body.style.cursor = 'pointer';
          }
        }}
        onPointerOut={() => {
          downPos.current = null;
          document.body.style.cursor = 'default';
        }}
      >
        <circleGeometry args={[r * 1.2, 28]} />
        <meshBasicMaterial
          transparent
          opacity={legal && canClick ? 0.1 : 0.001}
          color={legal ? '#c9b07a' : '#000'}
          depthWrite={false}
        />
      </mesh>

      {/* Protected (closed) pit cover — multi-round handicap */}
      {blocked && (
        <>
          <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.0008, 0]}>
            <circleGeometry args={[r * 0.95, 32]} />
            <meshBasicMaterial
              color="#0b0806"
              transparent
              opacity={0.72}
              depthWrite={false}
            />
          </mesh>
          <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.0012, 0]}>
            <ringGeometry args={[r * 0.88, r * 1.0, 36]} />
            <meshBasicMaterial
              color="#4a3a30"
              transparent
              opacity={0.35}
              side={THREE.DoubleSide}
              depthWrite={false}
            />
          </mesh>
        </>
      )}

      {/* Bowl fill flash */}
      <animated.mesh
        rotation={[-Math.PI / 2, 0, 0]}
        position={[0, 0.0005, 0]}
        scale={ringSpring.fillScale}
      >
        <circleGeometry args={[r * 0.92, 32]} />
        <animated.meshBasicMaterial
          color={isCollect ? '#ffd090' : isSaada ? '#d0b0f0' : '#e8d4a0'}
          transparent
          opacity={ringSpring.fillOpacity}
          depthWrite={false}
          depthTest={false}
          blending={THREE.AdditiveBlending}
        />
      </animated.mesh>

      {/* Collect burst */}
      <animated.mesh
        rotation={[-Math.PI / 2, 0, 0]}
        position={[0, 0.0015, 0]}
        scale={burstSpring.scale}
      >
        <ringGeometry args={[r * 0.55, r * 1.05, 40]} />
        <animated.meshBasicMaterial
          color="#fff0c8"
          transparent
          opacity={burstSpring.opacity}
          side={THREE.DoubleSide}
          depthWrite={false}
          depthTest={false}
          blending={THREE.AdditiveBlending}
        />
      </animated.mesh>

      {showRings && (
        <>
          <animated.mesh
            rotation={[-Math.PI / 2, 0, 0]}
            position={[0, 0.001, 0]}
            scale={pulseSpring.pulse}
          >
            <ringGeometry args={[r * 0.72, r * 1.2, 40]} />
            <animated.meshBasicMaterial
              color={ringColor}
              transparent
              opacity={ringSpring.ringOpacity.to((o) => o * 0.45)}
              side={THREE.DoubleSide}
              depthWrite={false}
              depthTest={false}
              blending={THREE.AdditiveBlending}
            />
          </animated.mesh>
          <animated.mesh
            rotation={[-Math.PI / 2, 0, 0]}
            position={[0, 0.002, 0]}
            scale={pulseSpring.pulse.to((p) => 1 + (p - 1) * 0.35)}
          >
            <ringGeometry args={[r * 0.86, r * 1.04, 40]} />
            <animated.meshBasicMaterial
              color={ringColor}
              transparent
              opacity={ringSpring.ringOpacity}
              side={THREE.DoubleSide}
              depthWrite={false}
              depthTest={false}
            />
          </animated.mesh>
        </>
      )}

      {showCount && (
        <AnimatedPitCount
          count={count}
          pitId={INDEX_TO_LABEL[index] ?? undefined}
          position={[0, 0.022, 0]}
          tone={
            aiPreview
              ? 'ai'
              : isCollect
                ? 'hot'
                : selected || highlight
                  ? 'hot'
                  : showHint
                    ? 'legal'
                    : 'default'
          }
        />
      )}
    </group>
  );
});

function RowMarkers() {
  // A = North (far, −Z in Three), B = South (near, +Z)
  return (
    <>
      <RowInitialMarker
        row="A"
        position={[-0.62, 0.06, -0.09]}
        subtitle="North · far"
      />
      <RowInitialMarker
        row="B"
        position={[-0.62, 0.06, 0.09]}
        subtitle="South · near"
      />
    </>
  );
}

/**
 * Real DOM focus target sitting on each pit (drei Html).
 * WebGL meshes are not tabbable — these buttons are.
 */
function PitFocusButton({
  index,
  count,
  legal,
  showHint,
  selected,
  canInput,
  onSelect,
}: {
  index: PitIndex;
  count: number;
  legal: boolean;
  showHint: boolean;
  selected: boolean;
  canInput: boolean;
  onSelect: (p: PitIndex) => void;
}) {
  const [x, y, z] = pitSurfacePosition(index);
  const label = INDEX_TO_LABEL[index] ?? String(index);
  const playable = canInput && legal;
  const side = index < 7 ? 'South' : 'North';

  return (
    <Html
      position={[x, y + 0.002, z]}
      center
      distanceFactor={1.35}
      zIndexRange={[40, 10]}
      style={{ pointerEvents: 'none' }}
      wrapperClass="board-pit-html"
    >
      <button
        type="button"
        className={[
          'board-pit-focus',
          // Visual hint ring only when Hints is on
          showHint ? 'is-legal' : '',
          selected ? 'is-selected' : '',
          !canInput ? 'is-locked' : '',
        ]
          .filter(Boolean)
          .join(' ')}
        // Keyboard always reaches playable pits, even with hints off
        tabIndex={playable ? 0 : -1}
        disabled={!playable}
        aria-disabled={!playable}
        aria-pressed={selected}
        aria-label={`${side} pit ${label}, ${count} seeds${playable ? ', can play' : ''}`}
        onClick={(e) => {
          e.stopPropagation();
          if (playable) onSelect(index);
        }}
        onKeyDown={(e) => {
          if (!playable) return;
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            e.stopPropagation();
            onSelect(index);
          }
        }}
      >
        <span className="board-pit-focus-ring" aria-hidden />
        <span className="sr-only">
          {label}: {count}
        </span>
      </button>
    </Html>
  );
}

function PitLayer() {
  const committed = useGameStore((s) => s.committed);
  const displayPits = useGameStore((s) => s.displayPits);
  const displayProtected = useGameStore((s) => s.displayProtected);
  const selectedPit = useGameStore((s) => s.selectedPit);
  const highlightPit = useGameStore((s) => s.highlightPit);
  const highlightPitsExtra = useGameStore((s) => s.highlightPitsExtra);
  const highlightKind = useGameStore((s) => s.highlightKind);
  const turnPhase = useGameStore((s) => s.turnPhase);
  const inputLocked = useGameStore((s) => s.inputLocked);
  const thinking = useGameStore((s) => s.thinking);
  const mode = useGameStore((s) => s.mode);
  const humanPlayer = useGameStore((s) => s.humanPlayer);
  const selectPit = useGameStore((s) => s.selectPit);
  const pendingDirection = useGameStore((s) => s.pendingDirection);
  const hintsEnabled = useGameStore((s) => s.hintsEnabled);

  const canInput = useMemo(() => {
    if (!committed) return false;
    return (
      !inputLocked &&
      !thinking &&
      !pendingDirection &&
      !isAiPhase(turnPhase) &&
      turnPhase !== 'animating' &&
      turnPhase !== 'pass' &&
      turnPhase !== 'over' &&
      (mode !== 'ai' || committed.toMove === humanPlayer)
    );
  }, [
    committed,
    inputLocked,
    thinking,
    pendingDirection,
    turnPhase,
    mode,
    humanPlayer,
  ]);

  /** Pits you may legally sow from (independent of Hints). */
  const legal = useMemo(() => {
    if (!committed || !canInput) return new Set<number>();
    return new Set(getLegalMoves(committed).map((m) => m.startPit));
  }, [committed, canInput]);

  const litPits = useMemo(() => {
    const s = new Set<number>();
    if (highlightPit !== null) s.add(highlightPit);
    for (const p of highlightPitsExtra) s.add(p);
    return s;
  }, [highlightPit, highlightPitsExtra]);

  // Stable tab order: North (A) left→right, then South (B) left→right
  const focusOrder = useMemo(
    () => [7, 8, 9, 10, 11, 12, 13, 0, 1, 2, 3, 4, 5, 6] as PitIndex[],
    [],
  );

  if (!committed) return null;

  return (
    <>
      <RowMarkers />
      {PITS.map((pit) => {
        const idx = pit.index as PitIndex;
        const isLegal = legal.has(idx);
        const isLit = litPits.has(idx);
        const isBlocked = Boolean(displayProtected[idx]);
        const kind = (isLit ? highlightKind : 'none') as HighlightKind;
        return (
          <PitHitTarget
            key={idx}
            index={idx}
            count={displayPits[idx] ?? 0}
            legal={isLegal && !isBlocked}
            showHint={isLegal && !isBlocked && hintsEnabled}
            selected={selectedPit === idx}
            highlight={isLit && turnPhase !== 'ai-preview'}
            highlightKind={turnPhase === 'ai-preview' && isLit ? 'ai' : kind}
            aiPreview={turnPhase === 'ai-preview' && isLit}
            canClick={canInput}
            showCount={!isBlocked}
            blocked={isBlocked}
            onSelect={selectPit}
          />
        );
      })}
      {focusOrder.map((idx) => {
        const isLegal = legal.has(idx);
        return (
          <PitFocusButton
            key={`focus-${idx}`}
            index={idx}
            count={displayPits[idx] ?? 0}
            legal={isLegal}
            showHint={isLegal && hintsEnabled}
            selected={selectedPit === idx}
            canInput={canInput}
            onSelect={selectPit}
          />
        );
      })}
    </>
  );
}

function SeedsLayer() {
  const displayPits = useGameStore((s) => s.displayPits);
  return <SeedInstances displayPits={displayPits} />;
}

function Stability() {
  const { gl } = useThree();
  useLayoutEffect(() => {
    const onLost = (e: Event) => {
      e.preventDefault();
      console.warn('[board] WebGL context lost');
    };
    const el = gl.domElement;
    el.addEventListener('webglcontextlost', onLost, false);
    return () => el.removeEventListener('webglcontextlost', onLost);
  }, [gl]);
  return null;
}

function StoreInvalidator() {
  const { invalidate } = useThree();
  useEffect(() => {
    return useGameStore.subscribe((state, prev) => {
      if (
        state.displayPits !== prev.displayPits ||
        state.displayScore !== prev.displayScore ||
        state.highlightPit !== prev.highlightPit ||
        state.highlightKind !== prev.highlightKind ||
        state.lastCaptureSide !== prev.lastCaptureSide ||
        state.turnPhase !== prev.turnPhase ||
        state.selectedPit !== prev.selectedPit ||
        state.inputLocked !== prev.inputLocked ||
        state.hintsEnabled !== prev.hintsEnabled
      ) {
        invalidate();
      }
    });
  }, [invalidate]);
  return null;
}

function CoconutLayer() {
  const displayScore = useGameStore((s) => s.displayScore);
  const lastCaptureSide = useGameStore((s) => s.lastCaptureSide);
  const mode = useGameStore((s) => s.mode);
  const humanPlayer = useGameStore((s) => s.humanPlayer);

  const southTitle =
    mode === 'ai' && humanPlayer === 'S'
      ? 'You · B'
      : mode === 'ai'
        ? 'AI · B'
        : 'South · B';
  const northTitle =
    mode === 'ai' && humanPlayer === 'N'
      ? 'You · A'
      : mode === 'ai'
        ? 'AI · A'
        : 'North · A';

  return (
    <CoconutStores
      scoreS={displayScore.S}
      scoreN={displayScore.N}
      southTitle={southTitle}
      northTitle={northTitle}
      pulseSide={lastCaptureSide}
    />
  );
}

function Scene() {
  const hasGame = useGameStore((s) => s.committed !== null);
  if (!hasGame) return null;

  return (
    <>
      <Stability />
      <ResponsiveFraming />
      <RenderWake frames={100} />
      <StoreInvalidator />
      {/* Warm night room — bright enough to read pits; static lights only */}
      <color attach="background" args={['#24180f']} />
      <fog attach="fog" args={['#24180f', 8, 20]} />

      <StudioLights quality="play" />

      {/* Room + static lamps (no flicker) — board key/fill is in StudioLights play */}
      <Suspense fallback={null}>
        <HomeVeranda floorSize={7.2} dynamicLights={false} />
      </Suspense>

      <group>
        <BoardMesh />
        <PitLayer />
        <SeedsLayer />
        <CoconutLayer />
        <FlyingSeed />
      </group>

      <GroundContactShadow
        position={[0, 0.002, 0]}
        opacity={0.32}
        scale={3.8}
        blur={2.6}
        far={1.4}
        color="#1a1008"
        resolution={CONTACT_SHADOW_RESOLUTION}
        frames={40}
      />

      <OrbitControls
        makeDefault
        enablePan={false}
        enableDamping
        dampingFactor={0.08}
        minDistance={0.95}
        maxDistance={4.5}
        minPolarAngle={0.28}
        maxPolarAngle={1.28}
        target={CAM_TARGET}
        touches={{
          ONE: THREE.TOUCH.ROTATE,
          TWO: THREE.TOUCH.DOLLY_PAN,
        }}
      />
    </>
  );
}

class BoardErrorBoundary extends Component<
  { children: ReactNode; onError?: () => void },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(err: Error) {
    console.error('[board]', err);
    this.props.onError?.();
  }

  render() {
    if (this.state.failed) return null;
    return this.props.children;
  }
}

export function BlenderBoard() {
  return (
    <div className="shader-board-wrap board-viewport-fill">
      <Canvas
        // Soft board shadow via GroundContactShadow only — no realtime cube/map shadows
        shadows={false}
        dpr={BOARD_DPR}
        frameloop="demand"
        gl={{
          antialias: !IS_LOW_POWER,
          alpha: false,
          powerPreference: 'high-performance',
          failIfMajorPerformanceCaveat: false,
          toneMapping: THREE.ACESFilmicToneMapping,
          toneMappingExposure: 0.95,
          outputColorSpace: THREE.SRGBColorSpace,
        }}
        camera={{ position: CAM_POS, fov: 42, near: 0.08, far: 28 }}
        style={{
          width: '100%',
          height: '100%',
          display: 'block',
          touchAction: 'none',
          background: '#24180f',
        }}
        onCreated={({ gl, camera, invalidate }) => {
          camera.lookAt(...CAM_TARGET);
          gl.setClearColor(0x24180f, 1);
          // Neutral exposure — avoid lifting specular hotspots on light wood
          gl.toneMappingExposure = 0.92;
          gl.shadowMap.enabled = false;
          gl.domElement.addEventListener('webglcontextlost', (e) => e.preventDefault());
          invalidate();
        }}
      >
        <Scene />
      </Canvas>
    </div>
  );
}

export { BoardErrorBoundary };

preloadBoardAssets();
preloadPlayEnvironment();
