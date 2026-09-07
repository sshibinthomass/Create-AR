/**
 * Reading an assembly's parts out of a loaded glTF scene.
 *
 * Shared by the viewer and by the offscreen renderer that shoots each part for
 * the namer: both have to agree exactly on which nodes are parts and what each
 * one is called, because a name is how a rename finds its object again.
 *
 * The measurements the viewer takes off those nodes live here too, rather than
 * in the viewer itself. The viewer is three.js and a third of a megabyte of
 * chunk, loaded only when there is a model to show; anything importing its
 * *values* -- rather than only its types -- drags all of that into the first
 * load. This module costs nothing to import, so what has to be shared is here.
 */
import type { Object3D } from 'three'

/**
 * The name each part carries *in the file*, not the one three.js gives it.
 *
 * GLTFLoader puts every node name through PropertyBinding.sanitizeNodeName,
 * which strips `[`, `]`, `.`, `:` and `/` -- the characters its animation
 * binding syntax reserves -- and turns whitespace into underscores. Maya and
 * Sketchfab exports namespace their parts with a colon, so what the viewer
 * calls a part can differ from what the exporter wrote. Names are how an edit
 * or a rename finds its object when the model is converted again, so they have
 * to be the file's own; the loader keeps the mapping to recover them.
 */
export interface NameSource {
  json?: { nodes?: { name?: string }[] }
  associations?: Map<object, { nodes?: number }>
}

export function fileNames(parser: NameSource | undefined): Map<Object3D, string> {
  const out = new Map<Object3D, string>()
  const nodes = parser?.json?.nodes
  if (!parser?.associations || !nodes) return out
  for (const [object, ref] of parser.associations) {
    const index = (ref as { nodes?: number })?.nodes
    if (index == null) continue
    const name = nodes[index]?.name
    if (name && (object as Object3D).isObject3D) out.set(object as Object3D, name)
  }
  return out
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
export function partNodes(scene: Object3D): Object3D[] {
  let level = scene.children.filter(hasGeometry)
  while (level.length === 1 && level[0].children.length) {
    const next = level[0].children.filter(hasGeometry)
    if (!next.length) break
    level = next
  }
  return level.length > 1 ? level : []
}

export interface PartSizes {
  /** The model's longest side. */
  model: number
  /** Each part's longest side, in the same units. */
  parts: number[]
  /**
   * Each part's face count.
   *
   * Here so the list can show which parts the namer will leave alone before a
   * single request is spent: one face means no enclosed volume, which the agent
   * always sets aside as a modelling artefact whatever the size floor says.
   */
  faces: number[]
  /**
   * Each part's box and where it sits, *in the space a move is applied in*.
   *
   * The two numbers above are world-space, because they are compared against
   * what the namer sees. These are not: a generated animation says "travel 0.4
   * along Y", and 0.4 has to mean the same thing here as it does when the
   * keyframe is played, which is the parent's space. On a Sketchfab export
   * wrapped in a scaled root the two differ by a couple of hundred times.
   */
  boxes: [number, number, number][]
  centres: [number, number, number][]
  /**
   * Each part's resting rotation, as a quaternion, in that same space.
   *
   * A keyframe's rotation turns the part about *its own* axes, while a box is
   * measured along the assembly's. Without this a rule that has worked out a
   * bolt lies along Y has no way to say which of the bolt's own axes that is.
   */
  spins: [number, number, number, number][]
  /** The model's own box in that space: how big it is, and where its middle is. */
  extents: [number, number, number]
  middle: [number, number, number]
}

/** A model with nothing readable in it. Also what the state starts as. */
export const NO_SIZES: PartSizes = {
  model: 1, parts: [], faces: [], boxes: [], centres: [], spins: [],
  extents: [1, 1, 1], middle: [0, 0, 0],
}
