import { useEffect, useMemo, useRef } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { ContactShadows, Float, OrbitControls, useGLTF } from '@react-three/drei';
import * as THREE from 'three';
import { getLegalMoves, type PitIndex } from '../../engine';
import {
  dropMsForSpeed,
  prefersReducedMotion,
} from '../../session/animationPace';
import { useGameStore, type TurnPhase } from '../../session/store';
import {
  HOP_REST_Y,
  hopDurationMs,
  hopPoint,
  hopSettleMs,
  randomHopLift,
  randomHopSkew,
  resolveHopBudgetMs,
  type Vec3,
} from '../hopMath';
import { createWoodMaterial } from '../shaders/woodMaterial';
import { createPitMaterial } from '../shaders/pitMaterial';
import { createSeedMaterial } from '../shaders/seedMaterial';
import { createTableMaterial } from '../shaders/tableMaterial';
import { BOARD_META, PITS, pitPosition, seedOffsets } from './layout';
import { gameTextures } from './loadTextures';
import { BOARD_URL, SEED_URL } from './assetUrls';
import { FLYER_SCALE_BOOST, HOP_ARC_BOOST } from './quality';

function isAiPhase(p: TurnPhase) {
  return p === 'ai-thinking' || p === 'ai-preview' || p === 'ai-playing';
}

const LIGHT_DIR = new THREE.Vector3(0.45, 0.88, 0.35).normalize();

/**
 * Blender GLB board + albedo/normal maps in custom GLSL materials.
 */
function BlenderBoardMesh({ highlight }: { highlight: number }) {
  const gltf = useGLTF(BOARD_URL);
  const maps = useMemo(() => gameTextures(), []);
  const woodMat = useMemo(
    () => createWoodMaterial({ albedo: maps.woodAlbedo, normal: maps.woodNormal }),
    [maps],
  );
  const pitMat = useMemo(() => createPitMaterial(maps.woodAlbedo), [maps]);

  const root = useMemo(() => {
    const scene = gltf.scene.clone(true);
    scene.traverse((obj) => {
      if (!(obj as THREE.Mesh).isMesh) return;
      const mesh = obj as THREE.Mesh;
      mesh.castShadow = true;
      mesh.receiveShadow = true;

      if (Array.isArray(mesh.material)) {
        mesh.material = mesh.material.map((m) => {
          const n = ((m as THREE.Material).name || '').toLowerCase();
          if (n.includes('pit') || n.includes('dark')) return pitMat;
          return woodMat;
        });
      } else {
        mesh.material = woodMat;
      }
    });

    scene.position.set(0, 0, 0);
    scene.rotation.set(0, 0, 0);
    scene.scale.set(1, 1, 1);
    return scene;
  }, [gltf, woodMat, pitMat]);

  useFrame(({ clock }) => {
    const t = clock.elapsedTime;
    woodMat.uniforms.uTime!.value = t;
    pitMat.uniforms.uTime!.value = t;
    (woodMat.uniforms.uLightDir!.value as THREE.Vector3).copy(LIGHT_DIR);
    (pitMat.uniforms.uLightDir!.value as THREE.Vector3).copy(LIGHT_DIR);
    woodMat.uniforms.uHighlight!.value = THREE.MathUtils.lerp(
      woodMat.uniforms.uHighlight!.value as number,
      highlight,
      0.1,
    );
  });

  useEffect(
    () => () => {
      woodMat.dispose();
      pitMat.dispose();
    },
    [woodMat, pitMat],
  );

  return <primitive object={root} />;
}

function PitHitTarget({
  index,
  legal,
  showHint,
  selected,
  highlight,
  aiPreview,
  canClick,
  onSelect,
}: {
  index: PitIndex;
  legal: boolean;
  showHint: boolean;
  selected: boolean;
  highlight: boolean;
  aiPreview: boolean;
  canClick: boolean;
  onSelect: (p: PitIndex) => void;
}) {
  const [x, y, z] = pitPosition(index);
  const r = BOARD_META.pitRadius;
  const ringColor = aiPreview
    ? '#9a8fb0'
    : selected || highlight
      ? '#c9a962'
      : showHint
        ? '#c9b07a'
        : '#000';
  const ringOpacity =
    aiPreview || selected || highlight ? 0.95 : showHint ? 0.5 : 0;

  // Drive pit shader accent via a shared approach — rings are the readable cue
  return (
    <group position={[x, y + 0.002, z]}>
      <mesh
        rotation={[-Math.PI / 2, 0, 0]}
        onClick={(e) => {
          e.stopPropagation();
          if (canClick && legal) onSelect(index);
        }}
        onPointerOver={(e) => {
          if (canClick && legal) {
            e.stopPropagation();
            document.body.style.cursor = 'pointer';
          }
        }}
        onPointerOut={() => {
          document.body.style.cursor = 'default';
        }}
      >
        <circleGeometry args={[r * 1.2, 32]} />
        <meshBasicMaterial transparent opacity={0.001} depthWrite={false} />
      </mesh>
      {ringOpacity > 0.02 && (
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.001, 0]}>
          <ringGeometry args={[r * 0.75, r * 1.12, 48]} />
          <meshBasicMaterial
            color={ringColor}
            transparent
            opacity={ringOpacity}
            side={THREE.DoubleSide}
            depthWrite={false}
          />
        </mesh>
      )}
    </group>
  );
}

const seedGeo = new THREE.SphereGeometry(1, 20, 16);

function SeedsLayer({
  displayPits,
  material,
}: {
  displayPits: number[];
  material: THREE.ShaderMaterial;
}) {
  return (
    <group>
      {PITS.map((pit) => {
        const [px, py, pz] = pitPosition(pit.index);
        const offs = seedOffsets(displayPits[pit.index] ?? 0, pit.radius);
        return offs.map((o, i) => (
          <mesh
            key={`${pit.index}-${i}`}
            geometry={seedGeo}
            material={material}
            position={[px + o[0], py + o[1], pz + o[2]]}
            scale={0.012}
            castShadow
          />
        ));
      })}
    </group>
  );
}

/**
 * Legacy shader board flyer — same hop contract as BlenderBoard / hopMath
 * (drop-only arcs, hopDurationMs, mid-hop continuity).
 */
function FlyingSeed({ material }: { material: THREE.ShaderMaterial }) {
  const highlightPit = useGameStore((s) => s.highlightPit);
  const highlightKind = useGameStore((s) => s.highlightKind);
  const turnPhase = useGameStore((s) => s.turnPhase);
  const animBudgetMs = useGameStore((s) => s.animBudgetMs);
  const travelSpeed = useGameStore((s) => s.settings.travelSpeed);
  const reducedMotion = useGameStore((s) => prefersReducedMotion(s.settings));
  const mesh = useRef<THREE.Mesh>(null);

  const hop = useRef({
    from: [0, HOP_REST_Y, 0] as Vec3,
    to: [0, HOP_REST_Y, 0] as Vec3,
    lift: 0,
    skew: 1,
    start: 0,
    dur: 280,
    live: false,
  });
  const progressRef = useRef(1);

  const activePhase =
    turnPhase === 'animating' ||
    turnPhase === 'ai-playing' ||
    turnPhase === 'ai-preview';

  useEffect(() => {
    const h = hop.current;
    if (highlightPit === null || !activePhase) {
      h.live = false;
      progressRef.current = 1;
      return;
    }

    const [x, y, z] = pitPosition(highlightPit);
    const r = PITS[highlightPit]?.radius ?? BOARD_META.pitRadius;
    const ja = Math.random() * Math.PI * 2;
    const jr = Math.sqrt(Math.random()) * r * 0.35;
    const dest: Vec3 = [x + Math.cos(ja) * jr, y + HOP_REST_Y, z + Math.sin(ja) * jr];

    const dropMs = resolveHopBudgetMs(
      animBudgetMs,
      highlightKind,
      travelSpeed,
      reducedMotion,
      dropMsForSpeed,
    );
    const isHop = highlightKind === 'drop' && !reducedMotion && dropMs > 0;
    const from = isHop
      ? hopPoint(h.from, h.to, progressRef.current, h.lift, h.skew)
      : dest;

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
    h.start = performance.now();
    h.dur = dur;
    h.live = true;
    progressRef.current = 0;
  }, [highlightPit, highlightKind, activePhase, animBudgetMs, reducedMotion]);

  useFrame(() => {
    if (!mesh.current) return;
    const h = hop.current;
    if (!h.live) {
      mesh.current.visible = false;
      material.uniforms.uPulse!.value = 0;
      return;
    }

    const elapsed = performance.now() - h.start;
    const t = Math.min(1, Math.max(0, h.dur > 0 ? elapsed / h.dur : 1));
    progressRef.current = t;
    const p = hopPoint(h.from, h.to, t, h.lift, h.skew);
    mesh.current.position.set(p[0], p[1], p[2]);
    const scaleIn = Math.min(1, t * 8 + (h.lift === 0 ? 1 : 0));
    // Unit sphere seed geo — keep base ~0.015 like resting SeedsLayer beads
    mesh.current.scale.setScalar(
      Math.max(0.008, scaleIn * 0.015 * (1 + (FLYER_SCALE_BOOST - 1) * 0.5)),
    );
    mesh.current.visible = true;
    material.uniforms.uPulse!.value = 1;
  });

  return (
    <mesh ref={mesh} geometry={seedGeo} material={material} castShadow visible={false} />
  );
}

function Table() {
  const maps = useMemo(() => gameTextures(), []);
  const mat = useMemo(() => createTableMaterial(maps.table), [maps]);
  useEffect(() => () => mat.dispose(), [mat]);
  return (
    <mesh
      rotation={[-Math.PI / 2, 0, 0]}
      position={[0, -0.002, 0]}
      receiveShadow
      material={mat}
    >
      <circleGeometry args={[1.8, 64]} />
    </mesh>
  );
}

function Scene() {
  const committed = useGameStore((s) => s.committed);
  const displayPits = useGameStore((s) => s.displayPits);
  const selectedPit = useGameStore((s) => s.selectedPit);
  const highlightPit = useGameStore((s) => s.highlightPit);
  const turnPhase = useGameStore((s) => s.turnPhase);
  const inputLocked = useGameStore((s) => s.inputLocked);
  const thinking = useGameStore((s) => s.thinking);
  const mode = useGameStore((s) => s.mode);
  const humanPlayer = useGameStore((s) => s.humanPlayer);
  const selectPit = useGameStore((s) => s.selectPit);
  const hintsEnabled = useGameStore((s) => s.hintsEnabled);

  const maps = useMemo(() => gameTextures(), []);
  const seedMat = useMemo(() => createSeedMaterial(maps.seed), [maps]);
  const flyMat = useMemo(() => createSeedMaterial(maps.seed), [maps]);

  useFrame(({ clock }) => {
    const t = clock.elapsedTime;
    seedMat.uniforms.uTime!.value = t;
    flyMat.uniforms.uTime!.value = t;
    (seedMat.uniforms.uLightDir!.value as THREE.Vector3).copy(LIGHT_DIR);
    (flyMat.uniforms.uLightDir!.value as THREE.Vector3).copy(LIGHT_DIR);
  });

  useEffect(
    () => () => {
      seedMat.dispose();
      flyMat.dispose();
    },
    [seedMat, flyMat],
  );

  if (!committed) return null;

  const canInput =
    !inputLocked &&
    !thinking &&
    !isAiPhase(turnPhase) &&
    turnPhase !== 'animating' &&
    turnPhase !== 'pass' &&
    turnPhase !== 'over' &&
    (mode !== 'ai' || committed.toMove === humanPlayer);

  const legal = new Set(
    canInput ? getLegalMoves(committed).map((m) => m.startPit) : [],
  );

  const boardGlow =
    turnPhase === 'your-turn' ? 0.4 : isAiPhase(turnPhase) ? 0.28 : 0.08;

  return (
    <>
      <color attach="background" args={['#0a0908']} />
      <fog attach="fog" args={['#0a0908', 2.5, 6.2]} />

      <ambientLight intensity={0.32} color="#d8c8b0" />
      <directionalLight
        castShadow
        intensity={1.7}
        color="#fff4e4"
        position={[1.3, 2.6, 1.1]}
        shadow-mapSize={[2048, 2048]}
        shadow-camera-near={0.2}
        shadow-camera-far={10}
        shadow-camera-left={-1.6}
        shadow-camera-right={1.6}
        shadow-camera-top={1.6}
        shadow-camera-bottom={-1.6}
      />
      <directionalLight intensity={0.38} color="#9a8fb0" position={[-1.4, 0.9, -0.9]} />
      <pointLight intensity={0.35} color="#c9a962" position={[0, 0.55, 0.45]} distance={2.2} />
      <hemisphereLight args={['#e8dcc8', '#100e0c', 0.28]} />

      <Float speed={0.5} rotationIntensity={0.015} floatIntensity={0.012}>
        <group>
          <BlenderBoardMesh highlight={boardGlow} />
          {PITS.map((pit) => {
            const idx = pit.index as PitIndex;
            return (
              <PitHitTarget
                key={idx}
                index={idx}
                legal={legal.has(idx)}
                showHint={legal.has(idx) && hintsEnabled}
                selected={selectedPit === idx}
                highlight={highlightPit === idx && turnPhase !== 'ai-preview'}
                aiPreview={turnPhase === 'ai-preview' && highlightPit === idx}
                canClick={canInput}
                onSelect={selectPit}
              />
            );
          })}
          <SeedsLayer displayPits={displayPits} material={seedMat} />
          <FlyingSeed material={flyMat} />
        </group>
      </Float>

      <Table />
      <ContactShadows
        position={[0, 0.0, 0]}
        opacity={0.6}
        scale={2.4}
        blur={2.6}
        far={1.4}
        color="#000"
      />

      <OrbitControls
        makeDefault
        enablePan={false}
        minDistance={0.75}
        maxDistance={2.1}
        minPolarAngle={0.35}
        maxPolarAngle={Math.PI / 2.2}
        target={[0, 0.04, 0.06]}
      />
    </>
  );
}

export function ShaderBoard() {
  const turnPhase = useGameStore((s) => s.turnPhase);
  const mode = useGameStore((s) => s.mode);
  const ai = isAiPhase(turnPhase);
  const you = turnPhase === 'your-turn' && mode === 'ai';

  return (
    <div
      className={[
        'shader-board-wrap',
        ai ? 'board-ai-turn' : '',
        you ? 'board-your-turn' : '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {ai && (
        <div className="board-ai-badge" aria-hidden>
          AI TURN
        </div>
      )}
      {you && (
        <div className="board-you-badge" aria-hidden>
          YOUR TURN
        </div>
      )}
      <Canvas
        shadows
        dpr={[1, 2]}
        gl={{
          antialias: true,
          alpha: false,
          powerPreference: 'high-performance',
          toneMapping: THREE.ACESFilmicToneMapping,
          toneMappingExposure: 1.08,
        }}
        camera={{ position: [0, 0.88, 1.1], fov: 30, near: 0.05, far: 20 }}
        style={{ width: '100%', height: '100%', borderRadius: 20 }}
      >
        <Scene />
      </Canvas>
      <div className="board3d-hint" aria-hidden>
        Drag to orbit · scroll to zoom · tap a pit
      </div>
    </div>
  );
}

useGLTF.preload(BOARD_URL);
useGLTF.preload(SEED_URL);
