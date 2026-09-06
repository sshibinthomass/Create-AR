/**
 * Photograph every part of a model, so a vision model can say what each one is.
 *
 * Each part gets up to two pictures: itself, alone and framed tight against a
 * plain backdrop, and -- when asked for -- the whole assembly with that one part
 * lit orange and the rest ghosted. The second is what separates a spacer from a
 * wheel hub: the shape alone rarely says, but where it sits usually does.
 *
 * The model is parsed a second time here rather than borrowed from the viewer.
 * Shooting a part means hiding its neighbours, restyling them and flying a
 * camera around, none of which the user should have to watch happen to the model
 * they are working on. The GLB is already in the browser cache, so the second
 * parse costs no network. `partGraph` is shared with the viewer so that both
 * arrive at the same parts under the same names -- a name is how a rename finds
 * its object again, so they cannot be allowed to drift.
 */
import {
  ACESFilmicToneMapping, Box3, Color, MathUtils, MeshStandardMaterial,
  PMREMGenerator, PerspectiveCamera, Scene, Spherical, Vector3, WebGLRenderer,
  type Material, type Mesh, type Object3D,
} from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'
import { isRestyled, type PartEdit } from './api'
import { poseEdited, restyleNode } from './partEdit'
import { fileNames, partNodes, type NameSource } from './partGraph'

export interface PartShot {
  /** Position in the part list, which is what the names come back keyed by. */
  index: number
  /** The name the file gives this part. */
  name: string
  /** base64 JPEG, no data: prefix -- the backend adds one. */
  isolated: string
  context: string
}

/** What a shot is rendered at unless the caller wants a bigger one. */
const SIZE = 512
const QUALITY = 0.82
/** Mid-slate: light parts and dark parts both stand off it. */
const BACKDROP = '#5a6172'
/** Where the camera sits relative to whatever it is framing. */
const EYE = new Vector3(1, 0.72, 1.15).normalize()
/** The same direction as angles, which is what turning the camera works in. */
const REST = new Spherical().setFromVector3(EYE)
/** Straight up and straight down are singular; stop just short of both. */
const PITCH_LIMIT = 0.02
/** How far in and out the live view may be pushed, as a factor of the framing. */
const DOLLY_RANGE: [number, number] = [0.35, 4]
/** Radians per pixel dragged: a drag across the view is a bit over half a turn. */
const TURN_PER_PX = 0.008
/** Wheel notches are exponential, so zooming in and back out lands where it was. */
const ZOOM_PER_NOTCH = 0.0012

/**
 * Point the camera at a box and back off far enough to hold all of it.
 *
 * `dir` is where the camera sits relative to the box and `dolly` scales how far
 * away -- both fixed for a still shot, and driven by the drag for a live one.
 */
function frame(camera: PerspectiveCamera, box: Box3, dir = EYE, dolly = 1) {
  const centre = box.getCenter(new Vector3())
  const radius = Math.max(box.getSize(new Vector3()).length() / 2, 1e-6)
  const distance = (radius / Math.sin((camera.fov * Math.PI) / 360)) * 1.25 * dolly
  camera.position.copy(centre).addScaledVector(dir, distance)
  // Both clip planes are pinned to this shot. Models arrive anywhere from a
  // millimetre to a kilometre across, and a fixed near plane swallows the small
  // ones whole. Measured against the radius rather than the distance so that
  // dollying all the way in does not clip the part away.
  camera.near = Math.max(distance - radius * 3, distance / 1000)
  camera.far = distance + radius * 3
  camera.lookAt(centre)
  camera.updateProjectionMatrix()
}

function release(root: Object3D) {
  root.traverse((node) => {
    const mesh = node as Mesh
    if (!mesh.isMesh) return
    mesh.geometry?.dispose()
    for (const material of [mesh.material].flat()) material?.dispose()
  })
}

/**
 * A loaded model, set up to have its parts photographed one at a time.
 *
 * Held open rather than rebuilt per shot: parsing the glTF and building the
 * environment is most of the cost, and both the namer (which wants every part)
 * and the viewer's preview panel (which wants whichever part is selected, over
 * and over) need the same setup. Whoever opens one is responsible for closing
 * it -- it holds a WebGL context and a second copy of the model on the GPU.
 */
export interface PartStudio {
  /** The parts, in the order the viewer lists them. */
  names: string[]
  /**
   * What the studio draws on. Square, because the framing below assumes it.
   *
   * A caller wanting a still shot never touches this; one wanting a view the
   * user can turn puts it in the page and drives `show` and `turn` instead of
   * asking for a JPEG per frame.
   */
  canvas: HTMLCanvasElement
  /**
   * One part alone, framed tight. base64 JPEG, no data: prefix.
   *
   * With an `edit`, the part is posed and restyled the way the viewer is
   * showing it, so the preview matches the model rather than the file. The
   * framing follows the part, so a move is invisible here and a rotation,
   * a non-uniform scale and a material change are not.
   */
  isolated(index: number, edit?: PartEdit): string
  /** The whole assembly, that part lit orange and the rest ghosted. */
  inContext(index: number): string
  /**
   * Put one part on the canvas and leave it there, framed from the resting
   * angle. Unlike `isolated` the pose and materials stay applied, because the
   * next thing to happen is usually the user turning the camera around them.
   */
  show(index: number, edit?: PartEdit): void
  /** Turn the camera about the shown part, by a drag in pixels. */
  turn(dx: number, dy: number): void
  /** Push the camera in or out, by a wheel delta. */
  zoom(delta: number): void
  /** Back to the angle and distance `show` started from. */
  recentre(): void
  close(): void
}

export async function openStudio(url: string, size = SIZE): Promise<PartStudio | null> {
  const gltf = await new GLTFLoader().loadAsync(url)
  const nodes = partNodes(gltf.scene)
  if (!nodes.length) return null
  const named = fileNames(gltf.parser as NameSource)

  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  // preserveDrawingBuffer, because the pixels are read back after the render
  // rather than during it.
  const renderer = new WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true })
  renderer.setSize(size, size, false)
  renderer.toneMapping = ACESFilmicToneMapping

  const pmrem = new PMREMGenerator(renderer)
  // A generated room rather than a fetched HDR: metal renders black without
  // something to reflect, and the app has to work offline.
  const environment = pmrem.fromScene(new RoomEnvironment(), 0.04)

  const stage = new Scene()
  stage.background = new Color(BACKDROP)
  stage.environment = environment.texture
  stage.add(gltf.scene)
  stage.updateMatrixWorld(true)

  const camera = new PerspectiveCamera(35, 1, 0.1, 100)
  // Where every part sits before any edit, so an edited pose can be composed
  // from rest each time and put back afterwards.
  const rest = nodes.map((node) => ({
    position: node.position.clone(),
    quaternion: node.quaternion.clone(),
    scale: node.scale.clone(),
  }))
  const boxes = nodes.map((node) => new Box3().setFromObject(node))
  const whole = boxes.reduce((all, box) => all.union(box), new Box3())

  const shoot = () => {
    renderer.render(stage, camera)
    return canvas.toDataURL('image/jpeg', QUALITY).replace(/^data:[^,]*,/, '')
  }

  // The ghost pass replaces every material in the scene, so the originals are
  // put back the moment an isolated shot is asked for again. Switching is what
  // costs, not the shot, so the two passes are kept apart where possible.
  let ghost: MeshStandardMaterial | null = null
  let lit: MeshStandardMaterial | null = null
  let original: Map<Mesh, Material | Material[]> | null = null

  const ghosted = (on: boolean) => {
    if (on === (original !== null)) return
    if (!on) {
      for (const [mesh, material] of original!) mesh.material = material
      original = null
      return
    }
    ghost ??= new MeshStandardMaterial({
      color: 0xffffff, roughness: 1,
      // Ghosts are drawn but leave the depth buffer alone, so a part buried
      // inside a housing still shows through it.
      transparent: true, opacity: 0.16, depthWrite: false,
    })
    original = new Map()
    for (const node of nodes) {
      node.traverse((child) => {
        const mesh = child as Mesh
        if (!mesh.isMesh) return
        original!.set(mesh, mesh.material)
        mesh.material = ghost!
      })
    }
  }

  /**
   * Show one part alone, in whatever pose and materials the edit gives it.
   *
   * Returns the box to frame it by and the undo that puts the model back. A
   * still shot undoes immediately; a live view holds on to it until the next
   * part is staged, because the pose has to survive every turn of the camera.
   */
  const stageOne = (index: number, edit?: PartEdit) => {
    ghosted(false)
    for (let j = 0; j < nodes.length; j++) nodes[j].visible = j === index

    const node = nodes[index]
    const at = rest[index]
    let made: Material[] = []
    let swapped = new Map<Mesh, Material | Material[]>()

    if (edit) {
      poseEdited(node, at.position, at.quaternion, at.scale, edit)
      node.updateMatrixWorld(true)
      if (isRestyled(edit)) {
        ({ original: swapped, made } = restyleNode(node, edit))
      }
    }

    return {
      // An edited part has moved, turned or stretched, so its box has to be
      // measured again rather than reused from the rest pose.
      box: edit ? new Box3().setFromObject(node) : boxes[index],
      undo: () => {
        if (!edit) return
        node.position.copy(at.position)
        node.quaternion.copy(at.quaternion)
        node.scale.copy(at.scale)
        node.updateMatrixWorld(true)
        for (const [mesh, material] of swapped) mesh.material = material
        for (const material of made) material.dispose()
      },
    }
  }

  // What the live view is holding: the part's undo, and the box and angles the
  // camera is orbiting. Kept out of React on purpose -- a drag redraws from the
  // pointer handler, not from a state change and a re-render.
  let live: { undo: () => void; box: Box3 } | null = null
  // Which part the live view is on, so that re-staging the same one after an
  // edit keeps the angle it was turned to. Nudging a slider and having the
  // camera snap back to the front every time makes the view useless for
  // watching what the slider does.
  let shown = -1
  let yaw = 0
  let pitch = 0
  let dolly = 1

  const drop = () => {
    live?.undo()
    live = null
  }

  const look = () => {
    if (!live) return
    const dir = new Vector3().setFromSphericalCoords(
      1,
      MathUtils.clamp(REST.phi + pitch, PITCH_LIMIT, Math.PI - PITCH_LIMIT),
      REST.theta + yaw,
    )
    frame(camera, live.box, dir, dolly)
    renderer.render(stage, camera)
  }

  return {
    names: nodes.map((node, i) => named.get(node) ?? node.name ?? `Part ${i + 1}`),
    canvas,

    isolated(index, edit) {
      // A still shot is taken from the resting angle, never through whatever
      // the live view happens to be turned to.
      drop()
      const held = stageOne(index, edit)
      frame(camera, held.box)
      const shot = shoot()
      held.undo()
      return shot
    },

    show(index, edit) {
      drop()
      live = stageOne(index, edit)
      if (index !== shown) {
        shown = index
        yaw = 0
        pitch = 0
        dolly = 1
      }
      look()
    },

    turn(dx, dy) {
      yaw -= dx * TURN_PER_PX
      pitch -= dy * TURN_PER_PX
      look()
    },

    zoom(delta) {
      dolly = MathUtils.clamp(dolly * Math.exp(delta * ZOOM_PER_NOTCH), ...DOLLY_RANGE)
      look()
    },

    recentre() {
      yaw = 0
      pitch = 0
      dolly = 1
      look()
    },

    inContext(index) {
      drop()
      ghosted(true)
      for (const node of nodes) node.visible = true
      lit ??= new MeshStandardMaterial({
        color: 0xff7a1a, roughness: 0.45, emissive: 0xff7a1a, emissiveIntensity: 0.3,
      })
      const marked: Mesh[] = []
      nodes[index].traverse((child) => {
        const mesh = child as Mesh
        if (!mesh.isMesh) return
        marked.push(mesh)
        mesh.material = lit!
      })
      // One framing for every context shot: the same view each time is what
      // lets the model compare where two parts sit.
      frame(camera, whole)
      const shot = shoot()
      for (const mesh of marked) mesh.material = ghost!
      return shot
    },

    close() {
      drop()
      ghosted(false)
      stage.remove(gltf.scene)
      release(gltf.scene)
      ghost?.dispose()
      lit?.dispose()
      environment.texture.dispose()
      pmrem.dispose()
      renderer.dispose()
      renderer.forceContextLoss()
    },
  }
}

/**
 * Render every part of the model at `url`.
 *
 * `onProgress` is called with how many pictures have been taken out of how many
 * are coming, and the loop yields between them so the page stays alive: a
 * hundred-part assembly is a few hundred renders.
 */
export async function capturePartShots(
  url: string,
  withContext: boolean,
  onProgress?: (done: number, total: number) => void,
): Promise<PartShot[]> {
  const studio = await openStudio(url)
  if (!studio) return []

  const total = studio.names.length * (withContext ? 2 : 1)
  let taken = 0

  try {
    // The isolated pass runs first, while every part still wears its own
    // materials -- the ghost pass replaces them all.
    const shots: PartShot[] = studio.names.map((name, index) => {
      const isolated = studio.isolated(index)
      onProgress?.(++taken, total)
      return { index, name, isolated, context: '' }
    })

    if (withContext) {
      for (const shot of shots) {
        shot.context = studio.inContext(shot.index)
        onProgress?.(++taken, total)
        // Yield between shots so the page stays alive: a hundred-part assembly
        // is a few hundred renders.
        await new Promise((done) => setTimeout(done, 0))
      }
    }
    return shots
  } finally {
    studio.close()
  }
}
