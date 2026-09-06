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
  type Material, type Object3D,
} from 'three'
import { MATERIALS, type PartEdit } from './api'

const DEG = Math.PI / 180
const BLACK = new Color('#000000')

/**
 * The material an edited part is shown in.
 *
 * Built fresh rather than cloned from the part's own: the export replaces the
 * material outright, textures included, so a preview that kept the original
 * maps would promise something the saved file does not deliver.
 */
export function buildMaterial(edit: PartEdit): Material {
  const preset = MATERIALS[edit.material as keyof typeof MATERIALS]
  const colour = new Color(edit.color)
  return new MeshPhysicalMaterial({
    color: colour,
    metalness: preset.metalness,
    roughness: preset.roughness,
    transmission: preset.transmission,
    thickness: preset.transmission ? 0.5 : 0,
    ior: 1.45,
    transparent: preset.transmission > 0,
    emissive: preset.emission ? colour : BLACK,
    emissiveIntensity: preset.emission,
  })
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
