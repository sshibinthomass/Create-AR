import {
  Component, Suspense, useCallback, useEffect, useMemo, useRef, useState,
  type ReactNode, type RefObject,
} from 'react'
import { Canvas, useFrame } from '@react-three/fiber'
import { Environment, Grid, Html, Lightformer, OrbitControls, useGLTF } from '@react-three/drei'
import {
  Box3, Box3Helper, Color, Matrix3, Matrix4, Vector3,
  type Group, type LineBasicMaterial, type Object3D,
} from 'three'

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

/** Does this node, or anything under it, actually draw something? */
function hasGeometry(node: Object3D): boolean {
  let found = false
  node.traverse((n) => {
    const o = n as { isMesh?: boolean; isPoints?: boolean; isLine?: boolean }
    if (o.isMesh || o.isPoints || o.isLine) found = true
  })
  return found
}

/**
 * The nodes to treat as the assembly's parts.
 *
 * Exporters wrap scenes to differing depths -- glTF adds a `RootNode`, others a
 * single transform root -- so a fixed depth would explode one model and do
 * nothing to the next. Instead descend through single-child wrappers until a
 * level holds more than one drawable node: that is where the parts are.
 */
function partNodes(scene: Object3D): Object3D[] {
  let level = scene.children.filter(hasGeometry)
  while (level.length === 1 && level[0].children.length) {
    const next = level[0].children.filter(hasGeometry)
    if (!next.length) break
    level = next
  }
  return level.length > 1 ? level : []
}

/** Evenly spread directions, for parts that sit dead on the centre. */
function spiralDirection(i: number, count: number): Vector3 {
  const y = count < 2 ? 0 : 1 - (i / (count - 1)) * 2
  const r = Math.sqrt(Math.max(0, 1 - y * y))
  const theta = i * 2.39996 // golden angle
  return new Vector3(Math.cos(theta) * r, y, Math.sin(theta) * r)
}

interface Part {
  node: Object3D
  name: string
  base: Vector3    // its resting position
  offset: Vector3  // where one unit of separation takes it, in the same space
  centre: Vector3  // its bounding-box centre, in its own local space
}

/**
 * Work out how each part flies apart: outward from the assembly centre and
 * proportional to how far off-centre it already sits, so the arrangement stays
 * recognisable instead of collapsing into an even starburst.
 */
function buildParts(scene: Object3D): Part[] {
  scene.updateWorldMatrix(false, true)
  const nodes = partNodes(scene)
  if (!nodes.length) return []

  const boxes = nodes.map((n) => new Box3().setFromObject(n))
  const whole = boxes.reduce((acc, b) => acc.union(b), new Box3())
  const centre = whole.getCenter(new Vector3())
  const radius = whole.getSize(new Vector3()).length() / 2 || 1

  return nodes.map((node, i) => {
    const offset = boxes[i].getCenter(new Vector3()).sub(centre)
    // A part sitting near the centre of the assembly -- a core inside a housing
    // -- has nowhere to go radially and would stay buried inside its neighbours
    // however far the slider is pushed. Measured against the part's own size,
    // because that is what decides whether it can ever clear them.
    const own = boxes[i].getSize(new Vector3()).length() / 2
    if (offset.length() < own / 2) {
      offset.copy(spiralDirection(i, nodes.length)).multiplyScalar(radius * 0.4)
    }
    // The offset is measured in world space but assigned to a local position,
    // so undo whatever rotation and scale the parent contributes.
    const toLocal = new Matrix3().setFromMatrix4(node.parent!.matrixWorld).invert()
    // Kept in the part's own space, so it survives the part being moved about.
    const localCentre = node.worldToLocal(boxes[i].getCenter(new Vector3()))
    return {
      node,
      name: node.name,
      base: node.position.clone(),
      offset: offset.applyMatrix3(toLocal),
      centre: localCentre,
    }
  })
}

/**
 * A floating name over each of the given parts, following them as they move.
 *
 * Positions are recomputed per frame rather than per separation change: the
 * parts are mutated outside React's render, so a frame is the only moment at
 * which their transforms are reliably settled.
 */
function PartLabels({ parts, names, selected, wrapper }: {
  parts: Part[]
  names: string[]
  selected: string | null
  wrapper: RefObject<Group | null>
}) {
  const refs = useRef<(Group | null)[]>([])
  const point = useMemo(() => new Vector3(), [])

  useFrame(() => {
    const root = wrapper.current
    if (!root) return
    parts.forEach((p, i) => {
      const label = refs.current[i]
      if (!label) return
      point.copy(p.centre).applyMatrix4(p.node.matrixWorld)
      label.position.copy(root.worldToLocal(point))
    })
  })

  return (
    <>
      {parts.map((p, i) => (
        <group key={`${p.name}-${i}`} ref={(el) => { refs.current[i] = el }}>
          <Html center zIndexRange={[40, 0]} style={{ pointerEvents: 'none' }}>
            <div className={`part-label${selected === p.name ? ' on' : ''}`}>
              {names[i] || 'Unnamed'}
            </div>
          </Html>
        </group>
      ))}
    </>
  )
}

/**
 * A box drawn around the selected part.
 *
 * Depth testing is off so a part buried inside the assembly is still findable
 * when the model is only half separated. The box is measured only when the
 * selection or the separation changes -- walking a heavy part's geometry every
 * frame would cost far more than it is worth.
 */
function SelectionBox({ part, separation, wrapper }: {
  part: Part
  separation: number
  wrapper: RefObject<Group | null>
}) {
  const helper = useMemo(() => {
    const h = new Box3Helper(new Box3(), new Color('#5b8cff'))
    h.renderOrder = 3
    const material = h.material as LineBasicMaterial
    material.depthTest = false
    material.transparent = true
    return h
  }, [])

  useEffect(() => {
    const root = wrapper.current
    if (!root) return
    root.updateWorldMatrix(true, true)
    helper.box.setFromObject(part.node)
    // Measured in world space, drawn as a child of the normalising wrapper.
    helper.box.applyMatrix4(new Matrix4().copy(root.matrixWorld).invert())
  }, [helper, part, separation, wrapper])

  return <primitive object={helper} />
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
function Model({ url, separation, showAllLabels, labels, selected, onSelect, onParts }: {
  url: string
  separation: number
  showAllLabels: boolean
  labels: Record<string, string>
  selected: string | null
  onSelect: (name: string | null) => void
  onParts: (names: string[]) => void
}) {
  const { scene } = useGLTF(url)
  const wrapper = useRef<Group>(null)

  const { scale, offset } = useMemo(() => {
    const box = new Box3().setFromObject(scene)
    const size = box.getSize(new Vector3())
    const centre = box.getCenter(new Vector3())
    const largest = Math.max(size.x, size.y, size.z)
    // Guard against degenerate or empty geometry producing 0 / Infinity.
    const k = Number.isFinite(largest) && largest > 0 ? 1 / largest : 1
    return { scale: k, offset: centre.multiplyScalar(-k) }
  }, [scene])

  const parts = useMemo(() => buildParts(scene), [scene])
  const names = useMemo(() => parts.map((p) => p.name), [parts])
  useEffect(() => onParts(names), [names, onParts])

  // The part nodes belong to the loaded glTF scene, which is mounted whole as a
  // single <primitive>, so separation is applied by mutating them directly.
  useEffect(() => {
    for (const p of parts) p.node.position.copy(p.base).addScaledVector(p.offset, separation)
    return () => { for (const p of parts) p.node.position.copy(p.base) }
  }, [parts, separation])

  // Drop the cached parse when this preview is replaced, so repeated
  // conversions of the same job id never show a stale mesh.
  useEffect(() => () => useGLTF.clear(url), [url])

  const chosen = parts.find((p) => p.name === selected) ?? null
  const labelled = showAllLabels ? parts : (chosen ? [chosen] : [])

  // A click lands on a mesh, which may be nested well below the part it belongs
  // to, so walk up until a part is reached.
  const owners = useMemo(() => new Map(parts.map((p) => [p.node, p.name])), [parts])
  const pick = (event: { object: Object3D; stopPropagation: () => void }) => {
    event.stopPropagation()
    let node: Object3D | null = event.object
    while (node && !owners.has(node)) node = node.parent
    onSelect(node ? owners.get(node)! : null)
  }

  return (
    <group ref={wrapper} scale={scale} position={[offset.x, offset.y, offset.z]}>
      <primitive object={scene} onPointerDown={pick} />
      {labelled.length > 0 && (
        <PartLabels
          parts={labelled}
          names={labelled.map((p) => labels[p.name] ?? p.name)}
          selected={selected}
          wrapper={wrapper}
        />
      )}
      {chosen && <SelectionBox part={chosen} separation={separation} wrapper={wrapper} />}
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

interface Props {
  url: string | null
  placeholder: string
  /** Open the separation panel as soon as a model loads. */
  explodeOpen?: boolean
  /** Part names to show in place of the model's own, keyed by the original. */
  labels?: Record<string, string>
  /** The picked part, by its original name: labelled and outlined. */
  selected?: string | null
  /** Fired when a part is clicked in the viewer, or the background is. */
  onSelect?: (name: string | null) => void
  /** The parts this model turned out to have, in the order they are drawn. */
  onParts?: (names: string[]) => void
  /** False parks the render loop, for a viewer sitting on a hidden tab. */
  active?: boolean
}

const RESTING_PCT = 40
const NO_LABELS: Record<string, string> = {}

export default function ModelViewer({
  url, placeholder, explodeOpen = false,
  labels = NO_LABELS, selected = null, onSelect, onParts, active = true,
}: Props) {
  const [open, setOpen] = useState(explodeOpen)
  const [pct, setPct] = useState(explodeOpen ? RESTING_PCT : 0)
  const [allNames, setAllNames] = useState(false)
  const [parts, setParts] = useState(0)

  // Held in a ref so an inline callback from the parent cannot re-fire the
  // report -- which would look to the view like a brand new model, and throw
  // away the names the user has typed.
  const sink = useRef(onParts)
  sink.current = onParts
  const report = useCallback((names: string[]) => {
    setParts(names.length)
    sink.current?.(names)
  }, [])

  const toggle = useCallback(() => {
    setOpen((was) => {
      setPct(was ? 0 : RESTING_PCT)  // closing reassembles the model
      return !was
    })
  }, [])

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
        <Canvas
          camera={{ position: [1.6, 1.2, 2.0], fov: 45, near: 0.01, far: 100 }}
          dpr={[1, 2]}
          frameloop={active ? 'always' : 'never'}
          onPointerMissed={() => onSelect?.(null)}
        >
          <color attach="background" args={['#10131c']} />
          <ambientLight intensity={0.35} />
          <directionalLight position={[4, 6, 4]} intensity={1.5} />
          <directionalLight position={[-5, 2, -3]} intensity={0.5} />

          <Suspense fallback={null}>
            <LocalEnvironment />
          </Suspense>

          <Suspense fallback={null}>
            <Model
              url={url}
              separation={(pct / 100) * 1.2}
              showAllLabels={allNames}
              labels={labels}
              selected={selected}
              onSelect={(name) => onSelect?.(name)}
              onParts={report}
            />
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

      <button className={`explode-btn${open ? ' on' : ''}`} onClick={toggle}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
             strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 2.5v4M12 17.5v4M2.5 12h4M17.5 12h4" />
          <rect x="9" y="9" width="6" height="6" rx="1" />
        </svg>
        {open ? 'Close separation' : 'Separate parts'}
      </button>

      {open && (
        <div className="explode-panel">
          <div className="explode-head">
            <span>Exploded view</span>
            <span>{parts ? `${parts} parts` : 'single part'}</span>
          </div>
          <input
            type="range" min={0} max={100} step={1} value={pct}
            disabled={parts === 0}
            aria-label="Separation"
            onChange={(e) => setPct(Number(e.target.value))}
          />
          {parts ? (
            <>
              <div className="explode-foot">
                <span>Assembled</span><span>{pct}%</span><span>Separated</span>
              </div>
              <label className="explode-names">
                <input type="checkbox" checked={allNames} onChange={(e) => setAllNames(e.target.checked)} />
                Name every part at once
              </label>
            </>
          ) : (
            <div className="explode-note">
              This model is one single part, so there is nothing to pull apart.
            </div>
          )}
        </div>
      )}

      <div className="viewer-hint">drag to orbit &middot; scroll to zoom</div>
    </div>
  )
}
