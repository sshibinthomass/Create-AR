/**
 * Reading an assembly's parts out of a loaded glTF scene.
 *
 * Shared by the viewer and by the offscreen renderer that shoots each part for
 * the namer: both have to agree exactly on which nodes are parts and what each
 * one is called, because a name is how a rename finds its object again.
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
