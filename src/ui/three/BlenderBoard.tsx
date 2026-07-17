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
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Html, OrbitControls, useGLTF } from '@react-three/drei';
import { animated, useSpring } from '@react-spring/three';
import * as THREE from 'three';
import { getLegalMoves, INDEX_TO_LABEL, type PitIndex } from '../../engine';
import {
  dropMsForSpeed,
  eventPaceFromDrop,
  prefersReducedMotion,
} from '../../session/animationPace';
import { useGameStore, type TurnPhase } from '../../session/store';
import { AnimatedPitCount, RowInitialMarker } from './AnimatedPitCount';
import { BOARD_URL, SEED_URL } from './assetUrls';
import { useBoardMaterialMaps } from './boardMaterialMaps';
import { CoconutStores, storeCaptureWorldPos } from './CoconutStores';
import {
  BOARD_META,
  MAX_PIT_SEEDS_DRAWN,
  PITS,
  pitPosition,
  pitSurfacePosition,
  seedOffsets,
} from './layout';
import { STORES } from './storeLayout';
import { RenderWake } from './RenderWake';
import {
  extractSeedGeometry,
  getSharedSeedMaterial,
  getStudioBoardRoot,
  preloadBoardAssets,
} from './sharedAssets';
import { GroundContactShadow } from './GroundContactShadow';
import { HomeVeranda } from './HomeVeranda';
import {
  BOARD_DPR,
  CONTACT_SHADOW_RESOLUTION,
  FLYER_SCALE_BOOST,
  HOP_ARC_BOOST,
  IS_LOW_POWER,
} from './quality';
import { StudioLights, preloadPlayEnvironment } from './StudioLights';
import {
  HOP_ARC_SEGMENTS,
  HOP_REST_Y,
  captureFlightDurationMs,
  hopDurationMs,
  hopPoint,
  hopSettleMs,
  randomHopLift,
  randomHopSkew,
  resolveHopBudgetMs,
  type Vec3,
} from '../hopMath';

/** Instanced board beads — total board never exceeds initialTotal (≤84 for 6/pit). */
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
      const count = Math.min(displayPits[i] ?? 0, MAX_PIT_SEEDS_DRAWN);
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

type HopState = {
  from: Vec3;
  to: Vec3;
  lift: number;
  skew: number;
  spin0: number;
  spin1: number;
  /** Wall-clock start of this hop (ms). */
  start: number;
  /** Duration of this hop (ms) — matched to travel-speed drop pacing. */
  dur: number;
  /** true while a bead is in flight / held above a pit */
  live: boolean;
  /** 0 = hidden, 1 = full size */
  appear: number;
};

/**
 * Bead that hops pit-to-pit during sowing.
 *
 * Driven by `useFrame` (not react-spring) so demand-mode canvases keep
 * painting every frame of the arc. Duration tracks the HUD travel-speed
 * slider. A short gold ribbon marks the hop path so the toss stays readable
 * even from the elevated play camera.
 */
function FlyingSeed() {
  const highlightPit = useGameStore((s) => s.highlightPit);
  const highlightKind = useGameStore((s) => s.highlightKind);
  const turnPhase = useGameStore((s) => s.turnPhase);
  const animBudgetMs = useGameStore((s) => s.animBudgetMs);
  const travelSpeed = useGameStore((s) => s.settings.travelSpeed);
  const reducedMotion = useGameStore((s) => prefersReducedMotion(s.settings));

  const { scene } = useGLTF(SEED_URL);
  const maps = useBoardMaterialMaps();
  const geometry = useMemo(() => extractSeedGeometry(scene), [scene]);
  const material = useMemo(() => getSharedSeedMaterial(maps.seed), [maps.seed]);
  const meshRef = useRef<THREE.Mesh>(null);
  const invalidate = useThree((s) => s.invalidate);

  const hop = useRef<HopState>({
    from: [0, HOP_REST_Y, 0],
    to: [0, HOP_REST_Y, 0],
    lift: 0,
    skew: 1,
    spin0: 0,
    spin1: 0,
    start: 0,
    dur: 280,
    live: false,
    appear: 0,
  });
  // Progress of the hop currently under way (0→1), kept so a mid-hop restart
  // continues from the bead's actual world position rather than snapping.
  const progressRef = useRef(1);

  // THREE.Line via primitive — JSX <line> collides with SVG's line element types.
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

  const activePhase =
    turnPhase === 'animating' ||
    turnPhase === 'ai-playing' ||
    turnPhase === 'ai-preview';

  useEffect(() => {
    const h = hop.current;
    if (highlightPit === null || !activePhase) {
      h.live = false;
      h.appear = 0;
      progressRef.current = 1;
      invalidate();
      return;
    }

    const [x, y, z] = pitPosition(highlightPit);
    const r = PITS[highlightPit]?.radius ?? BOARD_META.pitRadius;
    // Land at a random point inside the bowl, not dead center.
    const ja = Math.random() * Math.PI * 2;
    const jr = Math.sqrt(Math.random()) * r * 0.35;
    const dest: Vec3 = [x + Math.cos(ja) * jr, y + HOP_REST_Y, z + Math.sin(ja) * jr];

    // Prefer store-committed animBudgetMs; never invent a sow hop from the HUD.
    const dropMs = resolveHopBudgetMs(
      animBudgetMs,
      highlightKind,
      travelSpeed,
      reducedMotion,
      dropMsForSpeed,
    );
    // Only drops are real tosses between pits; pickup/relay/capture sit in place.
    const isHop = highlightKind === 'drop' && !reducedMotion && dropMs > 0;
    const curT = progressRef.current;
    const from = isHop
      ? hopPoint(h.from, h.to, curT, h.lift, h.skew)
      : dest;

    // Shared hop duration — slightly shorter than store sleep so the bead
    // lands before pit counts increment. Reduced-motion / batch: snap.
    const dur =
      dropMs === 0
        ? 1
        : isHop
          ? hopDurationMs(dropMs)
          : hopSettleMs(dropMs) || 1;

    h.from = from;
    h.to = dest;
    h.lift = isHop && dropMs > 0 ? randomHopLift(HOP_ARC_BOOST) : 0;
    h.skew = randomHopSkew();
    h.spin0 = h.spin1;
    h.spin1 = h.spin0 + (Math.random() * 0.9 + 0.55) * Math.PI;
    h.start = performance.now();
    h.dur = dur;
    h.live = true;
    h.appear = 1;
    progressRef.current = 0;
    invalidate();
    // travelSpeed only as fallback — animBudgetMs is the hop contract source.
  }, [
    highlightPit,
    highlightKind,
    activePhase,
    animBudgetMs,
    reducedMotion,
    invalidate,
  ]);

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
    const rawT = h.dur > 0 ? elapsed / h.dur : 1;
    const t = Math.min(1, Math.max(0, rawT));
    progressRef.current = t;

    const p = hopPoint(h.from, h.to, t, h.lift, h.skew);
    mesh.position.set(p[0], p[1], p[2]);
    mesh.rotation.y = h.spin0 + (h.spin1 - h.spin0) * t;
    // Pop in quickly, hold full size, slight settle at the end
    const scaleIn = Math.min(1, t * 8 + (h.lift === 0 ? 1 : 0));
    const scaleOut = t > 0.92 && h.lift > 0 ? 1 - (t - 0.92) * 0.35 : 1;
    mesh.scale.setScalar(
      Math.max(0.05, scaleIn * scaleOut * 1.22 * FLYER_SCALE_BOOST),
    );
    mesh.visible = true;

    // Draw the hop arch up to the bead — gold path so the toss is readable
    if (h.lift > 0.001) {
      const pos = arc.geometry.getAttribute('position') as THREE.BufferAttribute;
      for (let i = 0; i <= HOP_ARC_SEGMENTS; i++) {
        const u = (i / HOP_ARC_SEGMENTS) * t;
        const q = hopPoint(h.from, h.to, u, h.lift, h.skew);
        pos.setXYZ(i, q[0], q[1], q[2]);
      }
      pos.needsUpdate = true;
      arc.geometry.setDrawRange(0, Math.max(2, Math.floor(t * HOP_ARC_SEGMENTS) + 1));
      // Fade the ribbon as the bead lands
      (arc.material as THREE.LineBasicMaterial).opacity =
        0.2 + 0.65 * Math.sin(Math.PI * Math.min(1, t * 1.15));
      arc.visible = t > 0.02 && t < 0.98;
    } else {
      arc.visible = false;
    }

    // Keep demand-mode painting until the hop settles
    if (t < 1) {
      invalidate();
    } else if (h.lift > 0 && elapsed < h.dur + 40) {
      // Hold the landed bead briefly so it doesn't vanish before the pit count updates
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

const MAX_FLIGHT_SEEDS = 24;

type CaptureLeg = {
  from: Vec3;
  to: Vec3;
  delay: number;
  dur: number;
  lift: number;
  skew: number;
  spin0: number;
  spin1: number;
};

/**
 * Captured beads fly from their pits into the capturer's coconut store —
 * staggered arcs, one instanced mesh, self-terminating. Reacts to the store's
 * one-shot `captureFlight` event (id change), so undo/replays stay inert.
 */
function CaptureFlightSeeds() {
  const { scene } = useGLTF(SEED_URL);
  const maps = useBoardMaterialMaps();
  const geometry = useMemo(() => extractSeedGeometry(scene), [scene]);
  const material = useMemo(() => getSharedSeedMaterial(maps.seed), [maps.seed]);
  const meshRef = useRef<THREE.InstancedMesh>(null);
  const dummy = useMemo(() => new THREE.Object3D(), []);
  const invalidate = useThree((s) => s.invalidate);

  const legsRef = useRef<CaptureLeg[] | null>(null);
  const startRef = useRef(0);
  const lastIdRef = useRef(0);

  useEffect(() => {
    return useGameStore.subscribe((state) => {
      const ev = state.captureFlight;
      if (!ev || ev.id === lastIdRef.current) return;
      lastIdRef.current = ev.id;

      // Use the store-committed budget (not a fresh HUD sample) so flight
      // cannot outlive the capture sleep already in progress.
      const captureMs =
        ev.budgetMs > 0
          ? ev.budgetMs
          : eventPaceFromDrop(
              dropMsForSpeed(
                state.settings.travelSpeed,
                prefersReducedMotion(state.settings),
              ),
            ).capture;
      const flightDur = captureFlightDurationMs(captureMs) || 1;
      const maxDelay = Math.max(0, captureMs - flightDur);

      const dest = storeCaptureWorldPos(ev.side);
      const packR = (STORES[ev.side]?.seedPackRadius ?? 0.04) * 0.55;
      const legs: CaptureLeg[] = [];
      let pitOrder = 0;
      for (const { pit, amount } of ev.pits) {
        const [px, py, pz] = pitPosition(pit);
        const r = PITS[pit]?.radius ?? BOARD_META.pitRadius;
        // Fly a representative handful; full amount can be 20+ and overcrowds.
        const offsets = seedOffsets(Math.min(amount, 12), r);
        let beadIdx = 0;
        for (const o of offsets) {
          if (legs.length >= MAX_FLIGHT_SEEDS) break;
          const la = Math.random() * Math.PI * 2;
          const lr = Math.sqrt(Math.random()) * packR;
          legs.push({
            from: [px + o[0], py + o[1] + HOP_REST_Y * 0.4, pz + o[2]],
            to: [dest.x + Math.cos(la) * lr, dest.y, dest.z + Math.sin(la) * lr],
            // Provisional stagger; compressed below to fit store sleep.
            delay: pitOrder * 110 + beadIdx * 48 + Math.random() * 30,
            // No random overshoot — duration is hard ≤ captureMs.
            dur: flightDur,
            lift: randomHopLift(HOP_ARC_BOOST) * 1.05,
            skew: randomHopSkew(),
            spin0: Math.random() * Math.PI * 2,
            spin1: (Math.random() * 1.4 + 0.8) * Math.PI,
          });
          beadIdx++;
        }
        pitOrder++;
      }
      if (legs.length === 0) return;
      // Preserve relative cascade, but last bead must land before store advances.
      if (legs.length > 0) {
        const peak = Math.max(...legs.map((l) => l.delay));
        if (peak > maxDelay) {
          const scale = maxDelay > 0 ? maxDelay / peak : 0;
          for (const leg of legs) leg.delay *= scale;
        }
      }
      legsRef.current = legs;
      startRef.current = performance.now();
      invalidate();
    });
  }, [invalidate]);

  useFrame(() => {
    const mesh = meshRef.current;
    if (!mesh) return;
    const legs = legsRef.current;
    if (!legs) {
      if (mesh.count !== 0) {
        mesh.count = 0;
        mesh.instanceMatrix.needsUpdate = true;
      }
      return;
    }
    const elapsed = performance.now() - startRef.current;
    let pending = 0;
    let n = 0;
    for (const leg of legs) {
      const t = (elapsed - leg.delay) / leg.dur;
      if (t >= 1) continue;
      pending++;
      if (t < 0) continue;
      const p = hopPoint(leg.from, leg.to, t, leg.lift, leg.skew);
      // Pop in leaving the pit, sink away as it lands in the pile
      const scale =
        Math.min(1, t * 10) * (t > 0.9 ? Math.max(0.05, 1 - (t - 0.9) * 9) : 1);
      dummy.position.set(p[0], p[1], p[2]);
      // Partial mobile boost — a full flyer boost looks chunky ×18 beads
      dummy.scale.setScalar(scale * (1 + (FLYER_SCALE_BOOST - 1) * 0.6));
      dummy.rotation.set(0, leg.spin0 + (leg.spin1 - leg.spin0) * t, 0);
      dummy.updateMatrix();
      mesh.setMatrixAt(n++, dummy.matrix);
    }
    mesh.count = n;
    mesh.instanceMatrix.needsUpdate = true;
    if (pending > 0) {
      invalidate();
    } else {
      legsRef.current = null;
    }
  });

  return (
    <instancedMesh
      ref={meshRef}
      args={[geometry, material, MAX_FLIGHT_SEEDS]}
      castShadow
      receiveShadow={false}
      frustumCulled={false}
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
  preview,
  previewKind,
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
  /** Direction-chooser consequence preview (saada empty / capture bowls). */
  preview?: boolean;
  previewKind?: 'none' | 'path' | 'saada' | 'capture';
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
  const isPreviewCapture = Boolean(preview && previewKind === 'capture');
  const isPreviewSaada = Boolean(preview && previewKind === 'saada');
  const isPreview = Boolean(preview);
  const { invalidate } = useThree();

  const ringColor = isPreviewCapture
    ? '#dc785a'
    : isPreviewSaada
      ? '#c8a0dc'
      : isPreview
        ? '#d4a0c8'
        : aiPreview
          ? '#9a8fb0'
          : isCollect
            ? '#e8c070'
            : isSaada
              ? '#b898d0'
              : selected
                ? '#e0c989'
                : highlight
                  ? '#d4b878'
                  : showHint
                    ? '#a89060'
                    : '#000';

  // Clicks always respect legality; hints only affect idle ring visibility
  const interactive = canClick && legal;
  const downPos = useRef<{ x: number; y: number } | null>(null);

  // One soft pulse only while collecting beads — no idle throb
  const pulseSpring = useSpring({
    from: { pulse: 1 },
    to: { pulse: isCollect ? 1.04 : 1 },
    loop: isCollect ? { reverse: true } : false,
    config: { tension: 120, friction: 26 },
    onChange: () => invalidate(),
  });

  const ringSpring = useSpring({
    // Selected / AI / direction preview stay clear; sowing flashes stay subtle;
    // idle legal rings (Hints) are a thin whisper so the board stays calm.
    ringOpacity: isPreviewCapture
      ? 0.42
      : isPreviewSaada
        ? 0.36
        : isPreview
          ? 0.32
          : selected
            ? 0.38
            : aiPreview
              ? 0.3
              : isCollect
                ? 0.28
                : isSaada
                  ? 0.22
                  : isDrop
                    ? 0.14
                    : highlight
                      ? 0.16
                      : showHint
                        ? 0.12
                        : 0,
    fillOpacity: isPreviewCapture
      ? 0.08
      : isPreviewSaada
        ? 0.05
        : isCollect
          ? 0.06
          : isSaada
            ? 0.04
            : 0,
    fillScale: isCollect || isPreviewCapture ? 1.02 : 1,
    config: { tension: 240, friction: 28 },
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
      from: { scale: 0.95, opacity: 0.12 },
      to: { scale: 1.28, opacity: 0 },
      config: { duration: 320 },
      onChange: () => invalidate(),
    });
  }, [isCollect, highlightKind, index, burstApi, invalidate]);

  // Drop events no longer draw rings — the flying bead is enough feedback.
  // Rings only for: select, hints, collect/saada/AI, direction preview.
  const showRings =
    selected ||
    showHint ||
    aiPreview ||
    isPreview ||
    isCollect ||
    isSaada ||
    (highlight && highlightKind !== 'drop' && highlightKind !== 'none');

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
        {/* Invisible hit target — no gold wash under every legal pit */}
        <circleGeometry args={[r * 1.15, 28]} />
        <meshBasicMaterial
          transparent
          opacity={0.001}
          color="#000"
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

      {/* Soft bowl fill — collect / saada only (no drop flash) */}
      <animated.mesh
        rotation={[-Math.PI / 2, 0, 0]}
        position={[0, 0.0005, 0]}
        scale={ringSpring.fillScale}
      >
        <circleGeometry args={[r * 0.9, 32]} />
        <animated.meshBasicMaterial
          color={isCollect ? '#e8c878' : '#c8b0e0'}
          transparent
          opacity={ringSpring.fillOpacity}
          depthWrite={false}
          depthTest={false}
          blending={THREE.AdditiveBlending}
        />
      </animated.mesh>

      {/* Collect burst — quieter, shorter */}
      <animated.mesh
        rotation={[-Math.PI / 2, 0, 0]}
        position={[0, 0.0015, 0]}
        scale={burstSpring.scale}
      >
        <ringGeometry args={[r * 0.7, r * 0.98, 36]} />
        <animated.meshBasicMaterial
          color="#f0e0b0"
          transparent
          opacity={burstSpring.opacity}
          side={THREE.DoubleSide}
          depthWrite={false}
          depthTest={false}
          blending={THREE.AdditiveBlending}
        />
      </animated.mesh>

      {showRings && (
        // Single thin ring — no double halo
        <animated.mesh
          rotation={[-Math.PI / 2, 0, 0]}
          position={[0, 0.002, 0]}
          scale={pulseSpring.pulse}
        >
          <ringGeometry
            args={
              showHint && !selected && !highlight && !aiPreview
                ? [r * 0.92, r * 1.02, 36]
                : [r * 0.88, r * 1.04, 36]
            }
          />
          <animated.meshBasicMaterial
            color={ringColor}
            transparent
            opacity={ringSpring.ringOpacity}
            side={THREE.DoubleSide}
            depthWrite={false}
            depthTest={false}
          />
        </animated.mesh>
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
  const previewPits = useGameStore((s) => s.previewPits);
  const previewKind = useGameStore((s) => s.previewKind);

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

  const previewSet = useMemo(() => new Set(previewPits), [previewPits]);

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
            preview={previewSet.has(idx)}
            previewKind={previewKind}
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
        state.displayProtected !== prev.displayProtected ||
        state.highlightPit !== prev.highlightPit ||
        state.highlightKind !== prev.highlightKind ||
        state.lastCaptureSide !== prev.lastCaptureSide ||
        state.captureFlight !== prev.captureFlight ||
        state.turnPhase !== prev.turnPhase ||
        state.selectedPit !== prev.selectedPit ||
        state.pendingDirection !== prev.pendingDirection ||
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
        <CaptureFlightSeeds />
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
