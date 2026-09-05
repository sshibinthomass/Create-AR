import { Component, Suspense, useEffect, type ReactNode } from 'react'
import { Canvas } from '@react-three/fiber'
import { Bounds, Center, Environment, Grid, OrbitControls, useGLTF } from '@react-three/drei'

function Model({ url }: { url: string }) {
  const { scene } = useGLTF(url)
  // Drop the cached parse when this preview is replaced, so repeated
  // conversions of the same job id never show a stale mesh.
  useEffect(() => () => useGLTF.clear(url), [url])
  return (
    <Center>
      <primitive object={scene} />
    </Center>
  )
}

class ViewerBoundary extends Component<{ children: ReactNode; fallback: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  componentDidUpdate(prev: { children: ReactNode }) {
    if (prev.children !== this.props.children && this.state.failed) {
      this.setState({ failed: false })
    }
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
        <Canvas camera={{ position: [3, 2.5, 4], fov: 45 }} dpr={[1, 2]}>
          <color attach="background" args={['#10131c']} />
          <ambientLight intensity={0.5} />
          <directionalLight position={[5, 8, 5]} intensity={1.6} />
          <directionalLight position={[-5, 2, -5]} intensity={0.5} />
          <Suspense fallback={null}>
            <Bounds fit clip observe margin={1.25}>
              <Model url={url} />
            </Bounds>
            <Environment preset="city" />
          </Suspense>
          <Grid
            args={[20, 20]}
            cellColor="#242a3a"
            sectionColor="#2f3850"
            fadeDistance={26}
            fadeStrength={1.4}
            infiniteGrid
            position={[0, -0.001, 0]}
          />
          <OrbitControls makeDefault enableDamping dampingFactor={0.08} />
        </Canvas>
      </ViewerBoundary>
      <div className="viewer-hint">drag to orbit &middot; scroll to zoom</div>
    </div>
  )
}
