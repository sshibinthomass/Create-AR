import {
  Component, Suspense, useCallback, useEffect, useMemo, useRef, useState,
  type MutableRefObject, type ReactNode, type RefObject,
} from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import {
  Environment, Grid, Html, Lightformer, OrbitControls, TransformControls, useGLTF,
} from '@react-three/drei'
import {
  Box3, Box3Helper, Color, Euler, Matrix3, Matrix4, Object3D, Quaternion, Vector3,
  type Group, type LineBasicMaterial, type Material, type Mesh,
} from 'three'
import { NO_EDIT, type GizmoMode, type PartEdit } from '../api'
import { buildMaterial, poseEdited } from '../partEdit'
import { fileNames, partNodes, type NameSource } from '../partGraph'

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

/** Evenly spread directions, for parts that sit dead on the centre. */
function spiralDirection(i: number, count: number): Vector3 {
  const y = count < 2 ? 0 : 1 - (i / (count - 1)) * 2
  const r = Math.sqrt(Math.max(0, 1 - y * y))
  const theta = i * 2.39996 // golden angle
  return new Vector3(Math.cos(theta) * r, y, Math.sin(theta) * r)
}

interface Assembly {
  parts: Part[]
  /** How far a part may usefully be nudged, in the space `move` is applied in. */
  reach: number
}

interface Part {
  node: Object3D
  name: string
  base: Vector3    // its resting position
  baseQuat: Quaternion  // and the rest of its resting pose, which an edit replaces
  baseScale: Vector3
  offset: Vector3  // where one unit of radial separation takes it, in the same space
  toSlot: Vector3  // and where its cell of the fully laid-out sheet is
  centre: Vector3  // its bounding-box centre, in its own local space
}

/** Room left around a part inside its cell, as a multiple of the part itself. */
const CELL_PAD = 1.2
/** Roughly the shape a viewport is, so the laid-out sheet reads as one page. */
const SHEET_ASPECT = 2.4

/**
 * Where every part goes once the slider is pushed all the way: a flat sheet of
 * cells, one part to a cell, tallest first.
 *
 * Shelf packing rather than a uniform grid. Parts of one assembly differ in
 * size by orders of magnitude -- a car body and a screw -- so cells cut to the
 * largest would strand the small ones as specks in acres of nothing. Giving
 * each row only the height its own parts need keeps the sheet dense, which is
 * what makes it readable as an inventory rather than a scatter.
 *
 * Returned relative to the sheet's own centre, in the parts' parent space.
 */
function shelfSlots(sizes: Vector3[], extent: number): Vector3[] {
  // A part with no thickness on an axis -- a flat panel, a pane of glass --
  // would otherwise be handed a cell of no width and stack on its neighbour.
  const floor = extent * 0.012
  const cells = sizes.map((s) => ({
    w: Math.max(s.x, floor) * CELL_PAD,
    h: Math.max(s.y, floor) * CELL_PAD,
  }))
  const order = cells.map((_, i) => i).sort((a, b) => cells[b].h - cells[a].h)
  const target = Math.sqrt(cells.reduce((a, c) => a + c.w * c.h, 0) * SHEET_ASPECT)

  const slots: Vector3[] = new Array(sizes.length)
  const row: number[] = []
  let x = 0, top = 0, height = 0, width = 0

  // A row's height is only known once it is full, and its parts are centred on
  // it rather than hung from its top -- so they are given a y at that point,
  // not when they are placed.
  const settle = () => {
    for (const i of row) slots[i].y = top - height / 2
    row.length = 0
  }

  for (const i of order) {
    const cell = cells[i]
    if (x > 0 && x + cell.w > target) { settle(); top -= height; x = 0; height = 0 }
    slots[i] = new Vector3(x + cell.w / 2, 0, 0)
    row.push(i)
    x += cell.w
    width = Math.max(width, x)
    height = Math.max(height, cell.h)
  }
  settle()

  // Packed from a top-left origin; move the whole sheet onto that origin.
  const shift = new Vector3(-width / 2, (height - top) / 2, 0)
  return slots.map((s) => s.add(shift))
}

/**
 * Work out how each part flies apart: outward from the assembly centre and
 * proportional to how far off-centre it already sits, so the arrangement stays
 * recognisable instead of collapsing into an even starburst.
 */
function buildParts(scene: Object3D, names: Map<Object3D, string>): Assembly {
  scene.updateWorldMatrix(false, true)
  const nodes = partNodes(scene)
  if (!nodes.length) return { parts: [], reach: 1 }

  const boxes = nodes.map((n) => new Box3().setFromObject(n))
  const whole = boxes.reduce((acc, b) => acc.union(b), new Box3())
  const centre = whole.getCenter(new Vector3())
  const radius = whole.getSize(new Vector3()).length() / 2 || 1

  // A part's position lives in its parent's space, so that is the space the
  // separation and the move sliders both have to reach across. It and world
  // space can differ wildly: a Sketchfab export wraps the whole model in a
  // scaled root, which leaves the assembly a couple of hundredths of a unit
  // across in world space while its parts sit whole units apart in their own.
  // The parts are siblings, so one inverse serves the lot.
  const parent = nodes[0].parent!
  const fromWorld = new Matrix4().copy(parent.matrixWorld).invert()
  const toParent = new Matrix3().setFromMatrix4(parent.matrixWorld).invert()

  const span = whole.getSize(new Vector3()).applyMatrix3(toParent)
  const reach = Math.max(Math.abs(span.x), Math.abs(span.y), Math.abs(span.z))
  const extent = Number.isFinite(reach) && reach > 0 ? reach : 1

  // What the sheet is packed from, and what a slot has to be measured against:
  // where each part sits, and how big it is, in the space it will be moved in.
  const centres = boxes.map((b) => b.getCenter(new Vector3()).applyMatrix4(fromWorld))
  const sizes = boxes.map((b) => {
    const s = b.getSize(new Vector3()).applyMatrix3(toParent)
    return s.set(Math.abs(s.x), Math.abs(s.y), Math.abs(s.z))
  })
  const sheet = shelfSlots(sizes, extent)
  const sheetCentre = centre.clone().applyMatrix4(fromWorld)

  const parts = nodes.map((node, i) => {
    const offset = boxes[i].getCenter(new Vector3()).sub(centre)
    // A part sitting near the centre of the assembly -- a core inside a housing
    // -- has nowhere to go radially and would stay buried inside its neighbours
    // however far the slider is pushed. Measured against the part's own size,
    // because that is what decides whether it can ever clear them.
    const own = boxes[i].getSize(new Vector3()).length() / 2
    if (offset.length() < own / 2) {
      offset.copy(spiralDirection(i, nodes.length)).multiplyScalar(radius * 0.4)
    }
    // Kept in the part's own space, so it survives the part being moved about.
    const localCentre = node.worldToLocal(boxes[i].getCenter(new Vector3()))
    return {
      node,
      name: names.get(node) ?? node.name,
      base: node.position.clone(),
      baseQuat: node.quaternion.clone(),
      baseScale: node.scale.clone(),
      // The offset is measured in world space but assigned to a local position,
      // so undo whatever rotation and scale the parent contributes.
      offset: offset.applyMatrix3(toParent),
      // A slot is where the part's *visible* centre has to land, which is not
      // its origin: exporters routinely leave every part's origin on the world
      // origin and carry the shape as an offset inside it.
      toSlot: sheet[i].add(sheetCentre).sub(centres[i]),
      centre: localCentre,
    }
  })

  return { parts, reach: extent }
}

const DEG = Math.PI / 180
// Big enough to grab on a busy model, and drawn after everything else.
const GIZMO_SIZE = 1.4
const GIZMO_ORDER = 10_000

/** How far the radial burst throws a part, as a multiple of its own offset. */
const RADIAL_REACH = 1.4
/** The point in the travel at which the sheet starts to gather the parts in. */
const SHEET_FROM = 0.5

/**
 * Where the separation slider has pushed a part, in its parent's space.
 *
 * The travel runs through two arrangements rather than one. The first half is
 * a radial burst, which keeps the assembly recognisable while it opens up and
 * is what you want for looking inside something. Past the halfway mark the
 * parts are drawn instead into their cells of a flat sheet, so the far end of
 * the slider is a laid-out inventory of every piece rather than a cloud that
 * simply got bigger. The crossover is eased so neither arrangement snaps in.
 */
function displace(part: Part, separation: number, into: Vector3): Vector3 {
  into.copy(part.offset).multiplyScalar(separation * RADIAL_REACH)
  if (separation <= SHEET_FROM) return into
  const k = (separation - SHEET_FROM) / (1 - SHEET_FROM)
  return into.lerp(part.toSlot, k * k * (3 - 2 * k))
}

/**
 * Put a part into its edited pose, plus however far the separation slider has
 * pushed it out.
 *
 * The edit itself is composed in partEdit, which the preview panel's offscreen
 * renderer uses too. Separation is added on afterwards: it is a parent-space
 * translation like the move, so the two simply add, and it belongs to the
 * viewer alone -- it is a way of looking at the model, not part of the edit.
 */
function poseNode(part: Part, edit: PartEdit, separation: number) {
  poseEdited(part.node, part.base, part.baseQuat, part.baseScale, edit)
  part.node.position.add(displace(part, separation, new Vector3()))
}

/**
 * The inverse: read a part the gizmo has just dragged back out as an edit.
 *
 * The separation offset is subtracted first, so dragging a part while the model
 * is pulled apart records where the part was moved to, not where the slider had
 * already put it.
 */
function readNode(part: Part, separation: number, previous: PartEdit): PartEdit {
  const { node } = part
  const move = node.position.clone()
    .sub(part.base)
    .sub(displace(part, separation, new Vector3()))
  const spin = new Euler().setFromQuaternion(
    part.baseQuat.clone().invert().multiply(node.quaternion), 'XYZ')
  return {
    ...previous,
    move: [move.x, move.y, move.z],
    rotate: [spin.x / DEG, spin.y / DEG, spin.z / DEG],
    scale: [
      node.scale.x / (part.baseScale.x || 1),
      node.scale.y / (part.baseScale.y || 1),
      node.scale.z / (part.baseScale.z || 1),
    ],
  }
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
  selected: ReadonlySet<string>
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
            <div className={`part-label${selected.has(p.name) ? ' on' : ''}`}>
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
 * selection, the separation or the part's own edit changes -- walking a heavy
 * part's geometry every frame would cost far more than it is worth.
 *
 * The measurement waits for a frame rather than taking one in the effect that
 * marks it stale. Parts are moved from an effect in the parent, and React runs
 * a child's effects first, so measuring there would size the box from the pose
 * the part held before the change that triggered it.
 */
function SelectionBox({ part, separation, edit, wrapper }: {
  part: Part
  separation: number
  edit: PartEdit | undefined
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

  const stale = useRef(true)
  useEffect(() => { stale.current = true }, [part, separation, edit])

  useFrame(() => {
    const root = wrapper.current
    if (!stale.current || !root) return
    stale.current = false
    root.updateWorldMatrix(true, true)
    helper.box.setFromObject(part.node)
    // Measured in world space, drawn as a child of the normalising wrapper.
    helper.box.applyMatrix4(new Matrix4().copy(root.matrixWorld).invert())
  })

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
function Model({
  url, separation, showAllLabels, labels, edits, gizmo, selected, onSelect, onEdit, onParts,
}: {
  url: string
  separation: number
  showAllLabels: boolean
  labels: Record<string, string>
  edits: Record<string, PartEdit>
  gizmo: GizmoMode
  selected: readonly string[]
  onSelect: (name: string | null, additive: boolean) => void
  onEdit?: (changes: Record<string, PartEdit>) => void
  onParts: (names: string[], reach: number) => void
}) {
  const { scene, parser } = useGLTF(url)
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

  const { parts, reach } = useMemo(
    () => buildParts(scene, fileNames(parser as NameSource | undefined)),
    [scene, parser],
  )
  const names = useMemo(() => parts.map((p) => p.name), [parts])
  useEffect(() => onParts(names, reach), [names, reach, onParts])

  // The part nodes belong to the loaded glTF scene, which is mounted whole as a
  // single <primitive>, so both the separation and the user's edits are applied
  // by mutating them directly. They are applied together because they compete
  // for the same transform.
  //
  // While a gizmo is being dragged the parts are left alone: the gizmo is
  // writing to the same node, and re-posing it underneath would fight the drag.
  useEffect(() => {
    if (dragging.current) return
    for (const p of parts) poseNode(p, edits[p.name] ?? NO_EDIT, separation)
  }, [parts, separation, edits])

  // Restoring the rest pose is deliberately *not* the cleanup of the effect
  // above: that one re-runs on every edit, so mid-drag it would snap the very
  // node the gizmo is holding back to rest and the drag would walk away. The
  // parts belong to a cached glTF scene, so they still have to be put back when
  // this model goes away.
  useEffect(() => () => { for (const p of parts) poseNode(p, NO_EDIT, 0) }, [parts])

  // Only a part's material and colour reach the GPU, and building a
  // MeshPhysicalMaterial compiles a shader. Keying the effect below on the whole
  // edit would recompile one on every frame of a move or rotate drag, so it is
  // keyed on the styling alone -- which is why `edits` is read but not listed.
  const styling = JSON.stringify(
    parts.map((p) => {
      const edit = edits[p.name]
      return edit?.material ? [p.name, edit.material, edit.color] : 0
    }),
  )

  // Restyling replaces the part's materials outright, so the originals are put
  // back when the edit goes away -- the glTF's own materials are shared with
  // whatever else the cache is handing this scene to.
  useEffect(() => {
    const original = new Map<Mesh, Material | Material[]>()
    const made: Material[] = []
    for (const p of parts) {
      const edit = edits[p.name]
      if (!edit?.material) continue
      const material = buildMaterial(edit)
      made.push(material)
      p.node.traverse((n) => {
        const mesh = n as Mesh
        if (!mesh.isMesh) return
        original.set(mesh, mesh.material)
        mesh.material = material
      })
    }
    return () => {
      for (const [mesh, material] of original) mesh.material = material
      for (const material of made) material.dispose()
    }
  }, [parts, styling])

  // Drop the cached parse when this preview is replaced, so repeated
  // conversions of the same job id never show a stale mesh.
  useEffect(() => () => useGLTF.clear(url), [url])

  const marks = useMemo(() => new Set(selected), [selected])
  const picked = useMemo(() => parts.filter((p) => marks.has(p.name)), [parts, marks])
  const labelled = showAllLabels ? parts : picked

  // The gizmo does not grab the part itself. A part's own origin is where the
  // exporter put it, and plenty of models leave every one of them on the world
  // origin -- a Sketchfab export wraps each part in an identity node and offsets
  // the geometry inside it -- so handles drawn there would sit nowhere near the
  // part you clicked, all in the same spot. Instead an empty stands in at the
  // part's visible centre, and whatever motion it is given is passed on.
  //
  // It also lives outside the normalising wrapper, in plain world space, so the
  // handles come out a usable size whatever scale the model arrived at.
  const handle = useMemo(() => new Object3D(), [])
  // Only ever walked as a scene graph, so the concrete controls type -- which
  // drei takes from three-stdlib, not from @types/three -- does not matter.
  const controls = useRef<Object3D>(null) as React.RefObject<never>
  const dragging = useRef(false)
  // The part is pinned for the whole drag. A pointerdown on a handle also
  // reaches the mesh underneath it, so without this the selection can change
  // mid-drag and the motion gets applied to a part it was never measured
  // against -- which shows up as a translate that also rotates.
  const grab = useRef<{ from: Matrix4; held: { part: Part; at: Matrix4 }[] } | null>(null)

  // With several parts marked the empty sits at the middle of the group, so a
  // rotation swings them about their shared centre rather than each spinning on
  // the spot -- which is what picking a set of parts and turning them means.
  const centreOn = useCallback((group: Part[]) => {
    if (!group.length || dragging.current) return
    const middle = new Box3()
    for (const p of group) {
      middle.expandByPoint(new Vector3().copy(p.centre).applyMatrix4(p.node.matrixWorld))
    }
    middle.getCenter(handle.position)
    handle.quaternion.identity()
    handle.scale.set(1, 1, 1)
    handle.updateMatrixWorld(true)
  }, [handle])

  /** Carry the empty's motion over to every held part, and read them back out. */
  const follow = () => {
    const grabbed = grab.current
    if (!grabbed) return
    handle.updateMatrixWorld(true)
    const motion = new Matrix4()
      .multiplyMatrices(handle.matrixWorld, new Matrix4().copy(grabbed.from).invert())

    const changes: Record<string, PartEdit> = {}
    for (const { part, at } of grabbed.held) {
      const { node } = part
      new Matrix4()
        .copy(node.parent!.matrixWorld).invert()
        .multiply(new Matrix4().multiplyMatrices(motion, at))
        .decompose(node.position, node.quaternion, node.scale)
      changes[part.name] = readNode(part, separation, edits[part.name] ?? NO_EDIT)
    }
    onEdit?.(changes)
  }

  // Draw the handles over the model rather than inside it. A part is usually
  // surrounded by the rest of the assembly -- a door sits within a car body --
  // so a depth-tested gizmo is buried the moment it is anchored on the part it
  // edits, which looks exactly like no gizmo at all.
  useEffect(() => {
    const root = controls.current as Object3D | null
    if (!root || !gizmo) return
    root.traverse((node) => {
      node.renderOrder = GIZMO_ORDER
      const held = (node as Mesh).material
      if (!held) return
      for (const material of Array.isArray(held) ? held : [held]) {
        material.depthTest = false
        material.depthWrite = false
      }
    })
  }, [gizmo, picked])

  // Re-centre on every frame the handle is not being held. The part is moved by
  // an effect and by the separation slider, both outside React's render, so a
  // frame is the only moment its transform is reliably settled -- the same
  // reason the labels are placed here.
  useFrame(() => {
    if (!dragging.current) centreOn(picked)
  })

  // A click lands on a mesh, which may be nested well below the part it belongs
  // to, so walk up until a part is reached.
  const owners = useMemo(() => new Map(parts.map((p) => [p.node, p.name])), [parts])
  const pick = (event: {
    object: Object3D
    stopPropagation: () => void
    shiftKey?: boolean
    ctrlKey?: boolean
    metaKey?: boolean
  }) => {
    event.stopPropagation()
    if (dragging.current) return  // the click that started a drag is not a pick
    let node: Object3D | null = event.object
    while (node && !owners.has(node)) node = node.parent
    onSelect(
      node ? owners.get(node)! : null,
      Boolean(event.shiftKey || event.ctrlKey || event.metaKey),
    )
  }

  return (
    <>
      <group ref={wrapper} scale={scale} position={[offset.x, offset.y, offset.z]}>
        <primitive object={scene} onPointerDown={pick} />
        {labelled.length > 0 && (
          <PartLabels
            parts={labelled}
            names={labelled.map((p) => labels[p.name] ?? p.name)}
            selected={marks}
            wrapper={wrapper}
          />
        )}
        {picked.map((p) => (
          <SelectionBox
            key={p.name} part={p} separation={separation}
            edit={edits[p.name]} wrapper={wrapper}
          />
        ))}
      </group>

      <primitive object={handle} />
      {picked.length > 0 && gizmo && onEdit && (
        <TransformControls
          ref={controls}
          object={handle}
          mode={gizmo}
          size={GIZMO_SIZE}
          onMouseDown={() => {
            dragging.current = true
            grab.current = {
              from: handle.matrixWorld.clone(),
              held: picked.map((p) => ({ part: p, at: p.node.matrixWorld.clone() })),
            }
          }}
          onObjectChange={follow}
          onMouseUp={() => {
            follow()
            dragging.current = false
            grab.current = null
          }}
        />
      )}
    </>
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
  /** Moves, rotations, scales and materials to preview, keyed the same way. */
  edits?: Record<string, PartEdit>
  /** Fired when a gizmo drag changes the marked parts. Enables the gizmo. */
  onEdit?: (changes: Record<string, PartEdit>) => void
  /** The picked part, by its original name: labelled and outlined. */
  selected?: readonly string[]
  /**
   * Fired when a part is clicked in the viewer, or the background is.
   * `additive` is set when shift or ctrl/cmd was held: add to the marks
   * rather than replace them.
   */
  onSelect?: (name: string | null, additive: boolean) => void
  /**
   * The parts this model turned out to have, in the order they are drawn,
   * with how far one may usefully be nudged in the space a move applies in.
   */
  onParts?: (names: string[], reach: number) => void
  /** False parks the render loop, for a viewer sitting on a hidden tab. */
  active?: boolean
}

const RESTING_PCT = 40

/**
 * What the model currently *is*, named under it as the slider travels.
 *
 * The arrangement changes character twice over the travel, and the caption is
 * how you know which one you are looking at without having to read the number.
 * Matched to `displace`: the sheet only starts gathering past halfway, so it is
 * not called an inventory until it has all but finished forming one.
 */
const STAGES: { upTo: number; label: string }[] = [
  { upTo: 4, label: 'Assembled model' },
  { upTo: 89, label: 'Separated parts' },
  { upTo: 100, label: 'Part inventory' },
]
const NO_LABELS: Record<string, string> = {}
const NO_EDITS: Record<string, PartEdit> = {}
const NO_SELECTION: readonly string[] = []

interface OrbitHandle {
  target: Vector3
  update: () => void
  enableDamping: boolean
}

interface View {
  camera: { position: Vector3; lookAt: (x: number, y: number, z: number) => void }
  controls: OrbitHandle | null
}

/** Where the camera starts, and where "Reset view" puts it back. */
const CAMERA_START: [number, number, number] = [1.6, 1.2, 2.0]

/**
 * Hands the camera out to the chrome around the canvas.
 *
 * The buttons are plain DOM outside the r3f tree, so they cannot reach the
 * camera themselves, and a ref on <OrbitControls> does not reliably arrive.
 */
function ViewBridge({ into }: { into: MutableRefObject<View | null> }) {
  const camera = useThree((state) => state.camera)
  const controls = useThree((state) => state.controls)
  useEffect(() => {
    into.current = { camera, controls: (controls as unknown as OrbitHandle) ?? null }
  }, [camera, controls, into])
  return null
}

const stroke = {
  fill: 'none', stroke: 'currentColor', strokeWidth: 1.7,
  strokeLinecap: 'round', strokeLinejoin: 'round',
} as const

const GIZMOS: { mode: Exclude<GizmoMode, null>; label: string; icon: JSX.Element }[] = [
  {
    mode: 'translate',
    label: 'Move',
    icon: (
      <svg width="13" height="13" viewBox="0 0 24 24" {...stroke}>
        <path d="M12 3v18M3 12h18M12 3 9.5 5.5M12 3l2.5 2.5M12 21l-2.5-2.5M12 21l2.5-2.5" />
        <path d="M3 12l2.5-2.5M3 12l2.5 2.5M21 12l-2.5-2.5M21 12l-2.5 2.5" />
      </svg>
    ),
  },
  {
    mode: 'rotate',
    label: 'Rotate',
    icon: (
      <svg width="13" height="13" viewBox="0 0 24 24" {...stroke}>
        <path d="M20 12a8 8 0 1 1-2.5-5.8" />
        <path d="M20 4v4h-4" />
      </svg>
    ),
  },
  {
    mode: 'scale',
    label: 'Scale',
    icon: (
      <svg width="13" height="13" viewBox="0 0 24 24" {...stroke}>
        <rect x="4" y="4" width="9" height="9" rx="1" />
        <path d="M13 13h7v7h-7M20 13l-3.5 3.5" />
      </svg>
    ),
  },
]

export default function ModelViewer({
  url, placeholder, explodeOpen = false, labels = NO_LABELS, edits = NO_EDITS,
  selected = NO_SELECTION, onSelect, onEdit, onParts, active = true,
}: Props) {
  const [open, setOpen] = useState(explodeOpen)
  const [pct, setPct] = useState(explodeOpen ? RESTING_PCT : 0)
  const [allNames, setAllNames] = useState(false)
  const [parts, setParts] = useState(0)
  const [gizmo, setGizmo] = useState<GizmoMode>(null)
  const [full, setFull] = useState(false)
  // Only ever asked to reset, so the concrete controls type is not worth
  // importing -- drei takes it from three-stdlib, not from @types/three.
  const view = useRef<View | null>(null)

  // Held in a ref so an inline callback from the parent cannot re-fire the
  // report -- which would look to the view like a brand new model, and throw
  // away the names the user has typed.
  const sink = useRef(onParts)
  sink.current = onParts
  const report = useCallback((names: string[], reach: number) => {
    setParts(names.length)
    sink.current?.(names, reach)
  }, [])

  /**
   * Put the camera back where it started.
   *
   * The framing is set here rather than through the controls' own reset(),
   * which restores the pose it captured when it was constructed -- before r3f
   * had moved the camera to where this viewer wanted it, so it lands on a
   * default view instead of the one the model was first framed in.
   *
   * Damping is switched off across the change: the eased rotation left over
   * from the drag that got you here is held inside the controls and would carry
   * on turning the camera out of the pose just restored. Without damping the
   * same update zeroes it.
   */
  const resetView = useCallback(() => {
    const current = view.current
    if (!current) return
    const { camera, controls } = current
    const damped = controls?.enableDamping ?? false
    if (controls) {
      // The drag that got you here leaves an eased rotation inside the controls,
      // and the next update applies it -- on top of whatever pose is set first.
      // One update with damping off consumes it; the pose is set after that.
      controls.enableDamping = false
      controls.update()
    }
    camera.position.set(...CAMERA_START)
    controls?.target.set(0, 0, 0)
    camera.lookAt(0, 0, 0)
    controls?.update()
    if (controls) controls.enableDamping = damped
  }, [])

  const toggle = useCallback(() => {
    setOpen((was) => {
      setPct(was ? 0 : RESTING_PCT)  // closing reassembles the model
      return !was
    })
  }, [])

  /**
   * Filling the window is a fixed overlay rather than the Fullscreen API.
   * Taking the element fullscreen for real moves it in the layout, and the
   * WebGL canvas is torn down and rebuilt around that -- which on a heavy
   * assembly is a visible stall every time, and loses the camera with it.
   * Escape leaves, because that is what every fullscreen view has taught.
   */
  useEffect(() => {
    if (!full) return
    const leave = (e: KeyboardEvent) => { if (e.key === 'Escape') setFull(false) }
    const scroll = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    window.addEventListener('keydown', leave)
    return () => {
      document.body.style.overflow = scroll
      window.removeEventListener('keydown', leave)
    }
  }, [full])

  if (!url) {
    return (
      <div className="viewer">
        <div className="viewer-empty">{placeholder}</div>
      </div>
    )
  }

  return (
    <div className={`viewer${full ? ' full' : ''}`}>
      <ViewerBoundary
        key={url}
        fallback={<div className="viewer-empty">Preview could not be rendered.<br />The download is still available.</div>}
      >
        <Canvas
          camera={{ position: CAMERA_START, fov: 45, near: 0.01, far: 100 }}
          dpr={[1, 2]}
          frameloop={active ? 'always' : 'never'}
          onPointerMissed={() => onSelect?.(null, false)}
        >
          <ViewBridge into={view} />
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
              separation={pct / 100}
              showAllLabels={allNames}
              labels={labels}
              edits={edits}
              gizmo={gizmo}
              selected={selected}
              onSelect={(name, additive) => onSelect?.(name, additive)}
              onEdit={onEdit}
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
          <OrbitControls
            makeDefault
            enableDamping
            dampingFactor={0.08}
            // A wheel notch at the default speed crosses a good part of the
            // model, which on an assembly you are picking single parts out of
            // overshoots constantly. Orbit and pan are eased for the same
            // reason: the useful gesture here is a small adjustment.
            zoomSpeed={0.35}
            rotateSpeed={0.45}
            panSpeed={0.6}
          />
        </Canvas>
      </ViewerBoundary>

      <div className="viewer-tools">
        <button className="viewer-tool" title="Put the camera back where it started" onClick={resetView}>
          <svg width="14" height="14" viewBox="0 0 24 24" {...stroke}>
            <path d="M3 12a9 9 0 1 0 2.6-6.4" />
            <path d="M3 4v5h5" />
          </svg>
          Reset view
        </button>

        <button className={`viewer-tool${open ? ' on' : ''}`} onClick={toggle}>
          <svg width="14" height="14" viewBox="0 0 24 24" {...stroke}>
            <path d="M12 2.5v4M12 17.5v4M2.5 12h4M17.5 12h4" />
            <rect x="9" y="9" width="6" height="6" rx="1" />
          </svg>
          {open ? 'Close separation' : 'Separate parts'}
        </button>

        <button
          className={`viewer-tool${full ? ' on' : ''}`}
          title={full ? 'Back to the page (Esc)' : 'Fill the window with the model'}
          onClick={() => setFull((was) => !was)}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" {...stroke}>
            {full
              ? <path d="M9 3v6H3M15 3v6h6M9 21v-6H3M15 21v-6h6" />
              : <path d="M3 9V3h6M21 9V3h-6M3 15v6h6M21 15v6h-6" />}
          </svg>
          {full ? 'Exit full screen' : 'Full screen'}
        </button>
      </div>

      <div className="viewer-bottom">
        {parts > 0 && (
          <div className="explode-stage">
            <span>{STAGES.find((stage) => pct <= stage.upTo)!.label}</span>
          </div>
        )}

        {open && (
          <div className="explode-panel">
            <div className="explode-main">
              <div className="explode-head">
                <span>Explode model</span>
                <span className="explode-pct">{pct}<i>%</i></span>
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
                    <span>Assembled</span>
                    <span>{parts} parts</span>
                    <span>Every piece</span>
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

            <button
              className="explode-reset"
              title="Put every part back where it started"
              disabled={pct === 0}
              onClick={() => setPct(0)}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" {...stroke}>
                <path d="M3 12a9 9 0 1 0 2.6-6.4" />
                <path d="M3 4v5h5" />
              </svg>
              Reset
            </button>
          </div>
        )}
      </div>

      {onEdit && selected.length > 0 && (
        <div className="gizmo-bar">
          {GIZMOS.map(({ mode, label, icon }) => (
            <button
              key={label}
              className={`gizmo-btn${gizmo === mode ? ' on' : ''}`}
              title={`${label} the marked part${selected.length > 1 ? 's' : ''}`}
              onClick={() => setGizmo((was) => (was === mode ? null : mode))}
            >
              {icon}
              {label}
            </button>
          ))}
        </div>
      )}

      <div className="viewer-hint">
        {gizmo && selected.length > 0
          ? 'drag a handle to edit · drag elsewhere to orbit'
          : 'drag to orbit · scroll to zoom · shift-click to mark more'}
      </div>
    </div>
  )
}
