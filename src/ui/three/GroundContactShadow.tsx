import { forwardRef, useImperativeHandle, useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { HorizontalBlurShader } from 'three/examples/jsm/shaders/HorizontalBlurShader.js';
import { VerticalBlurShader } from 'three/examples/jsm/shaders/VerticalBlurShader.js';

type Props = {
  opacity?: number;
  scale?: number;
  blur?: number;
  far?: number;
  resolution?: number;
  frames?: number;
  color?: string;
  position?: [number, number, number];
};

/**
 * Soft ground contact shadow (drei ContactShadows pattern).
 *
 * Fixes the outdoor blue-square bug: drei's ContactShadows reuses the canvas
 * clear color when rendering into its RT. With sky clear `#87a0b8` that fills
 * the whole shadow plane as a blue square. We clear the RT to transparent black.
 */
export const GroundContactShadow = forwardRef<THREE.Group, Props>(
  function GroundContactShadow(
    {
      opacity = 0.48,
      scale = 3.8,
      blur = 2.6,
      far = 1.4,
      resolution = 256,
      frames = 40,
      color = '#1a1008',
      position = [0, 0.002, 0],
    },
    fref,
  ) {
    const ref = useRef<THREE.Group>(null);
    const scene = useThree((s) => s.scene);
    const gl = useThree((s) => s.gl);
    const shadowCamera = useRef<THREE.OrthographicCamera>(null);

    const width = scale;
    const height = scale;

    const [
      renderTarget,
      planeGeometry,
      depthMaterial,
      blurPlane,
      horizontalBlurMaterial,
      verticalBlurMaterial,
      renderTargetBlur,
    ] = useMemo(() => {
      const rt = new THREE.WebGLRenderTarget(resolution, resolution);
      const rtBlur = new THREE.WebGLRenderTarget(resolution, resolution);
      rt.texture.generateMipmaps = rtBlur.texture.generateMipmaps = false;

      const geo = new THREE.PlaneGeometry(width, height).rotateX(Math.PI / 2);
      const blurMesh = new THREE.Mesh(geo);

      const depthMat = new THREE.MeshDepthMaterial();
      depthMat.depthTest = depthMat.depthWrite = false;
      depthMat.onBeforeCompile = (shader) => {
        shader.uniforms = {
          ...shader.uniforms,
          ucolor: { value: new THREE.Color(color) },
        };
        shader.fragmentShader = shader.fragmentShader.replace(
          `void main() {`,
          `uniform vec3 ucolor;
           void main() {`,
        );
        shader.fragmentShader = shader.fragmentShader.replace(
          'vec4( vec3( 1.0 - fragCoordZ ), opacity );',
          'vec4( ucolor * fragCoordZ * 2.0, ( 1.0 - fragCoordZ ) * 1.0 );',
        );
      };

      const hBlur = new THREE.ShaderMaterial(HorizontalBlurShader);
      const vBlur = new THREE.ShaderMaterial(VerticalBlurShader);
      hBlur.depthTest = vBlur.depthTest = false;

      return [rt, geo, depthMat, blurMesh, hBlur, vBlur, rtBlur];
    }, [resolution, width, height, color]);

    const blurShadows = (amount: number) => {
      blurPlane.visible = true;
      blurPlane.material = horizontalBlurMaterial;
      horizontalBlurMaterial.uniforms.tDiffuse.value = renderTarget.texture;
      horizontalBlurMaterial.uniforms.h.value = (amount * 1) / 256;
      gl.setRenderTarget(renderTargetBlur);
      gl.render(blurPlane, shadowCamera.current!);

      blurPlane.material = verticalBlurMaterial;
      verticalBlurMaterial.uniforms.tDiffuse.value = renderTargetBlur.texture;
      verticalBlurMaterial.uniforms.v.value = (amount * 1) / 256;
      gl.setRenderTarget(renderTarget);
      gl.render(blurPlane, shadowCamera.current!);
      blurPlane.visible = false;
    };

    const count = useRef(0);
    const prevClear = useMemo(() => new THREE.Color(), []);

    useFrame(() => {
      if (!shadowCamera.current || !ref.current) return;
      if (frames !== Infinity && count.current >= frames) return;
      count.current++;

      const initialBackground = scene.background;
      const initialOverride = scene.overrideMaterial;
      const prevAlpha = gl.getClearAlpha();
      gl.getClearColor(prevClear);

      ref.current.visible = false;
      scene.background = null;
      scene.overrideMaterial = depthMaterial;

      // Transparent black — empty RT pixels must not pick up sky clear color
      gl.setClearColor(0x000000, 0);
      gl.setRenderTarget(renderTarget);
      gl.clear(true, true, true);
      gl.render(scene, shadowCamera.current);
      blurShadows(blur);
      blurShadows(blur * 0.4);

      gl.setRenderTarget(null);
      gl.setClearColor(prevClear, prevAlpha);
      ref.current.visible = true;
      scene.overrideMaterial = initialOverride;
      scene.background = initialBackground;
    });

    useImperativeHandle(fref, () => ref.current!, []);

    return (
      <group ref={ref} position={position} rotation-x={Math.PI / 2}>
        <mesh geometry={planeGeometry} scale={[1, -1, 1]} rotation={[-Math.PI / 2, 0, 0]}>
          <meshBasicMaterial
            transparent
            map={renderTarget.texture}
            opacity={opacity}
            depthWrite={false}
          />
        </mesh>
        <orthographicCamera
          ref={shadowCamera}
          args={[-width / 2, width / 2, height / 2, -height / 2, 0, far]}
        />
      </group>
    );
  },
);
