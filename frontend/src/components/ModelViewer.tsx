import { Component, Suspense, useEffect, useMemo, type ReactNode } from 'react'
import { Canvas } from '@react-three/fiber'
import { Environment, Grid, Lightformer, OrbitControls, useGLTF } from '@react-three/drei'
import { Box3, Vector3 } from 'three'

/**
 * Image-based lighting built from in-scene emissive panels.
 *
 * <Environment> is given children rather than a `preset`: a preset fetches an
 * HDR from a CDN, which breaks offline use. Metallic PBR materials still need
 * *something* to reflect or they render pure black, so the environment is not
 * optional -- it just has to be generated locally.
 *
 * It is also mounted in its own Suspense boundary. Sharing one with the model
 * means anything slow here stops the model from ever appearing.
 */
function LocalEnvironment() {
  return (
    <Environment resolution={128} frames={1}>
      <color attach="background" args={['#1b1f2a']} />
      <Lightformer intensity={3} position={[0, 5, 0]} scale={[12, 12, 1]} rotation-x={Math.PI / 2} />
      <Lightformer intensity={1.1} position={[-6, 1, -2]} scale={[12, 4, 1]} rotation-y={Math.PI / 2} />
      <Lightformer intensity={0.8} position={[6, 0, 2]} scale={[12, 4, 1]} rotation-y={-Math.PI / 2} />
      <Lightformer intensity={0.6} position={[0, -4, 0]} scale={[12, 12, 1]} rotation-x={-Math.PI / 2} />
    </Environment>
  )
}

/**
 * Renders the model normalised to roughly one world unit.
 *
 * Converted models arrive at wildly different scales -- a CAD bracket is 0.06 m
 * across, an architectural export can be hundreds of metres. Framing the camera
 * to the model instead would push it inside the near plane for small parts and
 * clip them away entirely, so the model is scaled to the camera rather than the
 * other way round. Real dimensions are reported in the stats panel.
 */
function Model({ url }: { url: string }) {
  const { scene } = useGLTF(url)

  const { scale, offset } = useMemo(() => {
    const box = new Box3().setFromObject(scene)
    const size = box.getSize(new Vector3())
    const centre = box.getCenter(new Vector3())
    const largest = Math.max(size.x, size.y, size.z)
    // Guard against degenerate or empty geometry producing 0 / Infinity.
    const k = Number.isFinite(largest) && largest > 0 ? 1 / largest : 1
    return { scale: k, offset: centre.multiplyScalar(-k) }
  }, [scene])

  // Drop the cached parse when this preview is replaced, so repeated
  // conversions of the same job id never show a stale mesh.
  useEffect(() => () => useGLTF.clear(url), [url])

  return (
    <group scale={scale} position={[offset.x, offset.y, offset.z]}>
      <primitive object={scene} />
    </group>
  )
}

class ViewerBoundary extends Component<{ children: ReactNode; fallback: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children
  }
}

export default function ModelViewer({ url, placeholder }: { url: string | null; placeholder: string }) {
  if (!url) {
    return (
      <div className="viewer">
        <div className="viewer-empty">{placeholder}</div>
      </div>
    )
  }

  return (
    <div className="viewer">
      <ViewerBoundary
        key={url}
        fallback={<div className="viewer-empty">Preview could not be rendered.<br />The download is still available.</div>}
      >
        <Canvas camera={{ position: [1.6, 1.2, 2.0], fov: 45, near: 0.01, far: 100 }} dpr={[1, 2]}>
          <color attach="background" args={['#10131c']} />
          <ambientLight intensity={0.35} />
          <directionalLight position={[4, 6, 4]} intensity={1.5} />
          <directionalLight position={[-5, 2, -3]} intensity={0.5} />

          <Suspense fallback={null}>
            <LocalEnvironment />
          </Suspense>

          <Suspense fallback={null}>
            <Model url={url} />
          </Suspense>

          <Grid
            args={[10, 10]}
            cellSize={0.1}
            sectionSize={0.5}
            cellColor="#242a3a"
            sectionColor="#2f3850"
            fadeDistance={12}
            fadeStrength={1.2}
            infiniteGrid
            position={[0, -0.5, 0]}
          />
          <OrbitControls makeDefault enableDamping dampingFactor={0.08} />
        </Canvas>
      </ViewerBoundary>
      <div className="viewer-hint">drag to orbit &middot; scroll to zoom</div>
    </div>
  )
}
