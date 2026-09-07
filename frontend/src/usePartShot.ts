import { useEffect, useRef, useState } from 'react'
import { isEdited, type PartEdit } from './api'
import type { PartStudio } from './partShots'

/**
 * One part of a model, rendered on its own and kept up to date as it is edited.
 *
 * A selection box around a trim piece on a whole car tells you where the part
 * is and almost nothing about what it looks like. This renders that one part
 * alone, framed tight, posed and restyled the way it has been edited -- so it
 * shows the model being built rather than the file that was opened.
 *
 * The renderer is opened on the first part asked for rather than with the
 * model -- most of the cost is parsing the glTF and building the environment,
 * and a session that never looks at a part should not pay it. It is then held
 * open, because the alternative is re-parsing on every click.
 */

/** Long enough that a gizmo drag coalesces, short enough to feel immediate. */
const SETTLE_MS = 120
/** Enough to hold a working set of parts and poses without growing forever. */
const KEEP = 48

interface Shot {
  /** base64 JPEG, no data: prefix. Null while the first one is being drawn. */
  data: string | null
  failed: boolean
  /** Whether the part is being shown as edited rather than as it was authored. */
  touched: boolean
}

export function usePartShot(
  url: string,
  index: number,
  edit: PartEdit | undefined,
  /** Pixels square. A thumbnail wants far fewer than a full-size view. */
  size?: number,
): Shot {
  const [data, setData] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  const studio = useRef<Promise<PartStudio | null> | null>(null)
  const cache = useRef(new Map<string, string>())

  // A part with no edit renders once and is cached under a plain key; an edited
  // one is cached per pose, so returning to a pose already seen is instant. A
  // colour change with no material set restyles nothing, and `isEdited` already
  // knows that -- so it does not earn its own render.
  const touched = edit != null && isEdited(edit)
  const key = touched ? `${index}:${JSON.stringify(edit)}` : `${index}`

  // A new model, or a new size, means a new studio; the old one holds a WebGL
  // context and a copy of the model on the GPU, so it is closed rather than
  // left to a GC.
  useEffect(() => {
    const opening = import('./partShots').then((m) => m.openStudio(url, size))
    studio.current = opening
    cache.current = new Map()
    return () => {
      studio.current = null
      opening.then((it) => it?.close()).catch(() => {})
    }
  }, [url, size])

  useEffect(() => {
    const held = cache.current.get(key)
    if (held) {
      setData(held)
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
          setData(null)
          setFailed(true)
          return
        }
        const taken = it.isolated(index, touched ? edit : undefined)
        if (cache.current.size >= KEEP) {
          cache.current.delete(cache.current.keys().next().value as string)
        }
        cache.current.set(key, taken)
        setData(taken)
      }).catch(() => {
        if (!live) return
        setData(null)
        setFailed(true)
      })
    }, SETTLE_MS)

    return () => { live = false; window.clearTimeout(timer) }
    // `edit` is read but not depended on: `key` is its signature, and depending
    // on the object itself would re-run on every render the parent does.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, index, url, size])

  return { data, failed, touched }
}
