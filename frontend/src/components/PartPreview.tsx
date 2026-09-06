import { useEffect, useRef, useState } from 'react'
import { isEdited, type PartEdit } from '../api'
import type { PartStudio } from '../partShots'

/**
 * The selected part on its own, beside the assembly it came out of.
 *
 * A selection box around a trim piece on a whole car tells you where the part
 * is and almost nothing about what it looks like. This renders that one part
 * alone, framed tight, posed and restyled the way you have edited it -- so it
 * shows the model you are building rather than the file you opened.
 *
 * The renderer is opened on the first selection rather than with the model --
 * most of the cost is parsing the glTF and building the environment, and a
 * session that never clicks a part should not pay it. It is then held open,
 * because the alternative is re-parsing on every click.
 */

/** Long enough that a gizmo drag coalesces, short enough to feel immediate. */
const SETTLE_MS = 120
/** Enough to hold a working set of parts and poses without growing forever. */
const KEEP = 48

export default function PartPreview({ url, index, name, edit }: {
  url: string
  /** Which part, by its position in the viewer's list. */
  index: number
  name: string
  /** The move, rotation, scale and material the viewer is showing it with. */
  edit?: PartEdit
}) {
  const [shot, setShot] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  const studio = useRef<Promise<PartStudio | null> | null>(null)
  const cache = useRef(new Map<string, string>())

  // A part with no edit renders once and is cached under a plain key; an edited
  // one is cached per pose, so returning to a pose you have already seen is
  // instant. A colour change with no material set restyles nothing, and
  // `isEdited` already knows that -- so it does not earn its own render.
  const touched = edit != null && isEdited(edit)
  const key = touched ? `${index}:${JSON.stringify(edit)}` : `${index}`

  // A new model means a new studio; the old one holds a WebGL context and a
  // copy of the model on the GPU, so it is closed rather than left to a GC.
  useEffect(() => {
    const opening = import('../partShots').then((m) => m.openStudio(url))
    studio.current = opening
    cache.current = new Map()
    return () => {
      studio.current = null
      opening.then((it) => it?.close()).catch(() => {})
    }
  }, [url])

  useEffect(() => {
    const held = cache.current.get(key)
    if (held) {
      setShot(held)
      setFailed(false)
      return
    }

    let live = true
    // The previous picture stays up while the new one is drawn: blanking it on
    // every step of a drag is worse than a frame or two of staleness.
    setFailed(false)
    const timer = window.setTimeout(() => {
      studio.current?.then((it) => {
        if (!live) return
        // A part the viewer knows about that this parse does not is a mismatch
        // worth showing as a failure rather than a blank box.
        if (!it || index >= it.names.length) {
          setShot(null)
          setFailed(true)
          return
        }
        const taken = it.isolated(index, touched ? edit : undefined)
        if (cache.current.size >= KEEP) {
          cache.current.delete(cache.current.keys().next().value as string)
        }
        cache.current.set(key, taken)
        setShot(taken)
      }).catch(() => {
        if (!live) return
        setShot(null)
        setFailed(true)
      })
    }, SETTLE_MS)

    return () => { live = false; window.clearTimeout(timer) }
    // `edit` is read but not depended on: `key` is its signature, and depending
    // on the object itself would re-run on every render the parent does.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, index, url])

  return (
    <aside className="part-shot">
      <div className="part-shot-frame">
        {shot ? (
          <img src={`data:image/jpeg;base64,${shot}`} alt={`${name}, on its own`} />
        ) : (
          <span className="part-shot-wait">{failed ? 'No preview' : 'Rendering…'}</span>
        )}
      </div>
      <div className="part-shot-cap">{touched ? 'This part, edited' : 'This part alone'}</div>
    </aside>
  )
}
