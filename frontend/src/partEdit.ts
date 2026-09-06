/**
 * How an edit is laid onto a part: its pose, and the material it is shown in.
 *
 * Shared by the viewer and by the offscreen renderer behind the preview panel.
 * Both have to compose an edit the same way the exporter does, or what you look
 * at stops matching what you would get -- so the composition lives in one place
 * rather than being written out twice and left to drift.
 */
import {
  Color, Euler, MeshPhysicalMaterial, Quaternion, Vector3,
  type Material, type Mesh, type Object3D,
} from 'three'
import { MATERIALS, type PartEdit } from './api'

const DEG = Math.PI / 180
const BLACK = new Color('#000000')

/**
 * The material an edited part is shown in.
 *
 * With a preset chosen it is built fresh rather than cloned from the part's
 * own: the export replaces the material outright, textures included, so a
 * preview that kept the original maps would promise something the saved file
 * does not deliver.
 *
 * With no preset -- opacity on its own -- the opposite holds. Nothing is being
 * replaced, so `from` is copied and only faded, and the part keeps the finish
 * you are turning see-through in order to look through. Every caller owns what
 * comes back and has to dispose of it.
 */
export function buildMaterial(edit: PartEdit, from?: Material): Material {
  // Below full opacity the part stops writing depth, so whatever sits behind it
  // shows through instead of being clipped away by draw order.
  const clear = edit.opacity < 1
  if (!edit.material) {
    const copy = (from ?? new MeshPhysicalMaterial()).clone()
    copy.transparent = true
    copy.opacity = edit.opacity
    copy.depthWrite = !clear
    return copy
  }
  const preset = MATERIALS[edit.material as keyof typeof MATERIALS]
  const colour = new Color(edit.color)
  return new MeshPhysicalMaterial({
    color: colour,
    metalness: edit.metalness,
    roughness: edit.roughness,
    transmission: preset.transmission,
    thickness: preset.transmission ? 0.5 : 0,
    ior: 1.45,
    transparent: preset.transmission > 0 || clear,
    opacity: edit.opacity,
    depthWrite: !clear,
    emissive: preset.emission ? colour : BLACK,
    emissiveIntensity: preset.emission,
  })
}

/**
 * Lay an edit's styling over every material a part wears, and hand back what
 * to put where -- along with everything built, for the caller to dispose of.
 *
 * A preset replaces the lot, so one material serves the whole part however
 * many its meshes carry; a fade has to copy each one, because each is what it
 * is fading. Both the viewer and the offscreen renderer restyle this way.
 */
export function restyleNode(node: Object3D, edit: PartEdit): {
  original: Map<Mesh, Material | Material[]>
  made: Material[]
} {
  const original = new Map<Mesh, Material | Material[]>()
  const made: Material[] = []
  let shared: Material | null = null

  const swap = (from: Material): Material => {
    if (edit.material) {
      if (!shared) made.push(shared = buildMaterial(edit))
      return shared
    }
    const one = buildMaterial(edit, from)
    made.push(one)
    return one
  }

  node.traverse((child) => {
    const mesh = child as Mesh
    if (!mesh.isMesh) return
    original.set(mesh, mesh.material)
    mesh.material = Array.isArray(mesh.material)
      ? mesh.material.map(swap)
      : swap(mesh.material)
  })
  return { original, made }
}

/**
 * Put a node into its edited pose: its rest transform with the edit's deltas
 * laid on top.
 *
 * Rotation multiplies on the right and scale multiplies componentwise, which is
 * what makes them pivot on the part's own origin -- and is exactly the
 * composition the exporter performs, so a preview is not an approximation.
 *
 * The rest transform is passed in rather than read off the node, because the
 * node is usually already sitting in a previously edited pose.
 */
export function poseEdited(
  node: Object3D,
  base: Vector3,
  baseQuat: Quaternion,
  baseScale: Vector3,
  edit: PartEdit,
): void {
  node.position.copy(base).add(new Vector3(edit.move[0], edit.move[1], edit.move[2]))
  node.quaternion.copy(baseQuat).multiply(
    new Quaternion().setFromEuler(
      new Euler(edit.rotate[0] * DEG, edit.rotate[1] * DEG, edit.rotate[2] * DEG, 'XYZ')))
  node.scale.set(
    baseScale.x * edit.scale[0],
    baseScale.y * edit.scale[1],
    baseScale.z * edit.scale[2],
  )
}
