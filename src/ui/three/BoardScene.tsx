import { Suspense, useMemo, useRef } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import {
  ContactShadows,
  Environment,
  Html,
  OrbitControls,
  useGLTF,
} from '@react-three/drei';
import * as THREE from 'three';
import {
  getLegalMoves,
  INDEX_TO_LABEL,
  type PitIndex,
} from '../../engine';
import { useGameStore, type TurnPhase } from '../../session/store';
import { PITS_BY_INDEX } from './pitLayout';
import { pitWorldPosition, seedOffsets } from './seedPositions';
import { BOARD_URL, SEED_URL } from './assetUrls';

function isAiPhase(phase: TurnPhase): boolean {
  return phase === 'ai-thinking' || phase === 'ai-preview' || phase === 'ai-playing';
}

/**
 * Board GLB is already Y-up from Blender `export_yup`.
 * Origin = board center, bottom at y≈0. Do NOT rotate again.
 */

function BoardMesh() {
  const gltf = useGLTF(BOARD_URL);
  const cloned = useMemo(() => {
    // Prefer the mesh itself so we don't inherit an empty parent offset
    let source: THREE.Object3D = gltf.scene;
    gltf.scene.traverse((o) => {
      if ((o as THREE.Mesh).isMesh && o.name.toLowerCase().includes('board')) {
        source = o;
      }
    });
    const obj = source.clone(true);
    obj.position.set(0, 0, 0);
    obj.rotation.set(0, 0, 0);
    obj.scale.set(1, 1, 1);
    obj.updateMatrix();
    obj.updateMatrixWorld(true);
    obj.traverse((child) => {
      if ((child as THREE.Mesh).isMesh) {
        const mesh = child as THREE.Mesh;
        mesh.castShadow = true;
        mesh.receiveShadow = true;
      }
    });
    return obj;
  }, [gltf]);

  return <primitive object={cloned} />;
}

function SeedMesh({
  position,
  highlight,
  aiPreview,
}: {
  position: [number, number, number];
  highlight?: boolean;
  aiPreview?: boolean;
}) {
  const gltf = useGLTF(SEED_URL);
  const ref = useRef<THREE.Group>(null);
  const cloned = useMemo(() => {
    const c = gltf.scene.clone(true);
    c.position.set(0, 0, 0);
    c.rotation.set(0, 0, 0);
    c.scale.set(1, 1, 1);
    c.traverse((obj) => {
      if ((obj as THREE.Mesh).isMesh) {
        const mesh = obj as THREE.Mesh;
        mesh.castShadow = true;
        mesh.receiveShadow = true;
      }
    });
    return c;
  }, [gltf]);

  useFrame(({ clock }) => {
    if (!ref.current) return;
    const baseY = position[1];
    if (aiPreview) {
      ref.current.position.y = baseY + Math.sin(clock.elapsedTime * 6) * 0.003;
    } else if (highlight) {
      ref.current.position.y = baseY + Math.sin(clock.elapsedTime * 4) * 0.0015;
    } else {
      ref.current.position.y = baseY;
    }
  });

  return (
    <group
      ref={ref}
      position={position}
      scale={highlight || aiPreview ? 1.12 : 1}
    >
      <primitive object={cloned} />
    </group>
  );
}

function PitInteractive({
  pitIndex,
  count,
  legal,
  showHint,
  selected,
  highlight,
  aiPreview,
  dimmed,
  canInput,
  onSelect,
}: {
  pitIndex: PitIndex;
  count: number;
  legal: boolean;
  showHint: boolean;
  selected: boolean;
  highlight: boolean;
  aiPreview: boolean;
  dimmed: boolean;
  canInput: boolean;
  onSelect: (p: PitIndex) => void;
}) {
  const meta = PITS_BY_INDEX[pitIndex]!;
  const [wx, wy, wz] = pitWorldPosition(meta);
  const offsets = seedOffsets(Math.min(count, 16), meta.radius);
  const label = INDEX_TO_LABEL[pitIndex] ?? String(pitIndex);

  const ringColor = aiPreview
    ? '#9a8fb0'
    : selected || highlight
      ? '#c9a962'
      : showHint
        ? '#c9b07a'
        : '#000000';
  const ringOpacity =
    aiPreview || selected || highlight ? 0.95 : showHint ? 0.5 : 0;

  return (
    <group position={[wx, wy, wz]}>
      {/* Horizontal click disc on pit floor (XZ plane) */}
      <mesh
        rotation={[-Math.PI / 2, 0, 0]}
        position={[0, 0.001, 0]}
        onClick={(e) => {
          e.stopPropagation();
          if (canInput && legal) onSelect(pitIndex);
        }}
        onPointerOver={(e) => {
          if (canInput && legal) {
            e.stopPropagation();
            document.body.style.cursor = 'pointer';
          }
        }}
        onPointerOut={() => {
          document.body.style.cursor = 'default';
        }}
      >
        <circleGeometry args={[meta.radius * 1.05, 32]} />
        <meshBasicMaterial
          transparent
          opacity={showHint && canInput ? 0.12 : 0.001}
          color={showHint ? '#c9b07a' : '#000'}
          depthWrite={false}
        />
      </mesh>

      {(ringOpacity > 0 || aiPreview) && (
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.003, 0]}>
          <ringGeometry args={[meta.radius * 0.7, meta.radius * 1.05, 40]} />
          <meshBasicMaterial
            color={ringColor}
            transparent
            opacity={ringOpacity || 0.9}
            side={THREE.DoubleSide}
            depthWrite={false}
          />
        </mesh>
      )}

      {offsets.map((off, i) => (
        <SeedMesh
          key={i}
          position={off}
          highlight={highlight && i === 0}
          aiPreview={aiPreview && i === 0}
        />
      ))}

      <Html
        position={[0, 0.028, 0]}
        center
        distanceFactor={1.05}
        style={{
          pointerEvents: 'none',
          userSelect: 'none',
          fontFamily: 'system-ui, sans-serif',
          fontWeight: 800,
          fontSize: '12px',
          color: aiPreview ? '#c8bfd8' : selected ? '#e0c989' : '#f3ebe0',
          textShadow: '0 1px 3px #000, 0 0 6px rgba(0,0,0,0.85)',
          opacity: dimmed ? 0.5 : 1,
          whiteSpace: 'nowrap',
        }}
      >
        {count}
        {aiPreview ? ` · ${label}` : ''}
      </Html>
    </group>
  );
}

function SceneContents() {
  const committed = useGameStore((s) => s.committed);
  const displayPits = useGameStore((s) => s.displayPits);
  const selectedPit = useGameStore((s) => s.selectedPit);
  const highlightPit = useGameStore((s) => s.highlightPit);
  const turnPhase = useGameStore((s) => s.turnPhase);
  const inputLocked = useGameStore((s) => s.inputLocked);
  const thinking = useGameStore((s) => s.thinking);
  const hintsEnabled = useGameStore((s) => s.hintsEnabled);
  const mode = useGameStore((s) => s.mode);
  const humanPlayer = useGameStore((s) => s.humanPlayer);
  const selectPit = useGameStore((s) => s.selectPit);

  if (!committed) return null;

  const canInput =
    !inputLocked &&
    !thinking &&
    !isAiPhase(turnPhase) &&
    turnPhase !== 'animating' &&
    turnPhase !== 'pass' &&
    turnPhase !== 'over' &&
    (mode !== 'ai' || committed.toMove === humanPlayer);

  const legalStarts = new Set(
    canInput ? getLegalMoves(committed).map((m) => m.startPit) : [],
  );

  const aiActive = isAiPhase(turnPhase);
  const isAiPreview = turnPhase === 'ai-preview';

  return (
    <>
      <color attach="background" args={['#0a0908']} />
      <ambientLight intensity={0.5} color="#d8c8b0" />
      <directionalLight
        castShadow
        position={[0.5, 1.2, 0.6]}
        intensity={1.4}
        color="#fff4e4"
        shadow-mapSize={[1024, 1024]}
      />
      <directionalLight position={[-0.7, 0.5, -0.3]} intensity={0.35} color="#9a8fb0" />
      <hemisphereLight args={['#e8dcc8', '#100e0c', 0.32]} />

      <Suspense fallback={null}>
        {/* Board + pits share the same world space (glTF Y-up) */}
        <group>
          <BoardMesh />
          {PITS_BY_INDEX.map((pit) => {
            const idx = pit.index as PitIndex;
            const legal = legalStarts.has(idx);
            return (
              <PitInteractive
                key={idx}
                pitIndex={idx}
                count={displayPits[idx] ?? 0}
                legal={legal}
                showHint={legal && hintsEnabled}
                selected={selectedPit === idx}
                highlight={highlightPit === idx && !isAiPreview}
                aiPreview={isAiPreview && highlightPit === idx}
                dimmed={
                  (aiActive && idx < 7) || (canInput && mode === 'ai' && idx >= 7)
                }
                canInput={canInput}
                onSelect={selectPit}
              />
            );
          })}
        </group>

        <ContactShadows
          position={[0, 0.001, 0]}
          opacity={0.4}
          scale={1.5}
          blur={2}
          far={0.6}
        />
        <Environment
          files="/hdr/wooden_lounge_1k.hdr"
          environmentIntensity={0.55}
          environmentRotation={[0, Math.PI * 0.35, 0]}
          ground={{ height: 7, radius: 24, scale: 40 }}
        />
      </Suspense>

      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.002, 0]} receiveShadow>
        <circleGeometry args={[1.1, 48]} />
        <meshStandardMaterial color="#12100e" roughness={0.92} metalness={0.04} />
      </mesh>

      <OrbitControls
        makeDefault
        enablePan={false}
        minDistance={0.5}
        maxDistance={1.5}
        minPolarAngle={0.4}
        maxPolarAngle={Math.PI / 2.2}
        target={[0, 0.03, 0]}
      />
    </>
  );
}

export function BoardScene() {
  const turnPhase = useGameStore((s) => s.turnPhase);
  const mode = useGameStore((s) => s.mode);
  const aiActive = isAiPhase(turnPhase);
  const yourTurn = turnPhase === 'your-turn' && mode === 'ai';

  return (
    <div
      className={[
        'board3d-wrap',
        aiActive ? 'board-ai-turn' : '',
        yourTurn ? 'board-your-turn' : '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {aiActive && (
        <div className="board-ai-badge" aria-hidden>
          AI TURN · NORTH
        </div>
      )}
      {yourTurn && (
        <div className="board-you-badge" aria-hidden>
          YOUR TURN · SOUTH
        </div>
      )}
      <Canvas
        shadows
        dpr={[1, 1.75]}
        // Camera looks from +Z (south side) toward board center
        camera={{ position: [0, 0.65, 0.85], fov: 32, near: 0.05, far: 20 }}
        gl={{ antialias: true, alpha: false }}
        style={{ width: '100%', height: '100%', borderRadius: 16 }}
      >
        <SceneContents />
      </Canvas>
      <div className="board3d-hint" aria-hidden>
        Drag to orbit · scroll to zoom · tap a pit to play
      </div>
    </div>
  );
}

useGLTF.preload(BOARD_URL);
useGLTF.preload(SEED_URL);
