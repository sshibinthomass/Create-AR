import { type ReactNode, useEffect, useRef, useState } from 'react'
import {
  isEdited, NO_EDIT, type NamerSettings, type PartDetails, type PartEdit, type Pose,
} from '../api'
import { restAxes } from '../animation'
import type { PartStudio } from '../partShots'
import { nameOnePart } from '../useNamer'
import PartEditor from './PartEditor'
import TransformReadout from './TransformReadout'

/**
 * One component, on its own and full size.
 *
 * The thumbnail beside the viewer says what a part looks like; this is where
 * you work on it. The same render at a size worth looking at, the name and the
 * description as editable fields, the namer pointed at this one part, the move
 * and material sliders, and the button that takes the part out of the model.
 *
 * Name and description are held as a draft and applied on Save, because a
 * generated answer is a starting point -- the whole reason to open this dialog
 * on a part the namer has already been over is to correct what it said. The
 * transform below is live instead: a slider you cannot see the effect of is
 * not a slider, and the render beside it redraws as you drag.
 */

/** Rendered larger than the thumbnail, since this is the view worth looking at. */
const SHOT_SIZE = 960

/** The description, as rows the user can reorder nothing about but can edit. */
type Rows = [label: string, text: string][]

const toRows = (details: PartDetails): Rows => Object.entries(details)

/** Back to a document's details: blank labels are dropped, as the server does. */
function fromRows(rows: Rows): PartDetails {
  const out: PartDetails = {}
  for (const [label, text] of rows) {
    const key = label.trim()
    if (key) out[key] = text.trim()
  }
  return out
}

const sameDetails = (a: PartDetails, b: PartDetails) =>
  JSON.stringify(Object.entries(a)) === JSON.stringify(Object.entries(b))

export default function PartDialog({
  url, index, total, originalName, name, details, edit, extent, settings, taken,
  removed, onSave, onEdit, onResetEdit, onRemove, onRestore, onClose,
}: {
  /** The converted GLB the viewer is showing, which this renders from. */
  url: string
  /** Which part, by its position in the viewer's list. */
  index: number
  total: number
  /** What the file calls the part -- the key every change is stored under. */
  originalName: string
  /** What it is currently called, which is the original until it is renamed. */
  name: string
  details: PartDetails
  edit: PartEdit | undefined
  /** The model's largest dimension, which sets how far a part can be nudged. */
  extent: number
  settings: NamerSettings | null
  /** The names the other parts are going by, so a generated one avoids them. */
  taken: readonly string[]
  removed: boolean
  onSave: (name: string, details: PartDetails) => void
  onEdit: (next: PartEdit) => void
  onResetEdit: () => void
  onRemove: () => void
  onRestore: () => void
  onClose: () => void
}) {
  const [draftName, setDraftName] = useState(name)
  const [rows, setRows] = useState<Rows>(() => toRows(details))
  const [asking, setAsking] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // A different part in the same dialog starts over. Keyed on the part rather
  // than mounted afresh so the render below is not thrown away with it.
  useEffect(() => {
    setDraftName(name)
    setRows(toRows(details))
    setError(null)
    // Only when the part changes: re-seeding on every change to `details` would
    // wipe the draft the moment a save landed elsewhere.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [originalName])

  const dirty = draftName !== name || !sameDetails(fromRows(rows), details)

  /**
   * Undo one number, one channel, or the whole edit. Only the last is the
   * parent's business -- it is the one that takes the part off the edited
   * list; the rest are a change to the edit like any other.
   */
  const resetEdit = (key: keyof Pose | null, axis: number | null) => {
    if (key === null || !edit) onResetEdit()
    else onEdit({ ...edit, [key]: restAxes(edit, key, axis) })
  }

  // Escape closes, the way every other dialog does -- but not out from under
  // unsaved work.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      if (!dirty || window.confirm('Discard the unsaved name and description?')) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [dirty, onClose])

  const leave = () => {
    if (!dirty || window.confirm('Discard the unsaved name and description?')) onClose()
  }

  async function describe() {
    if (!settings) return
    setAsking(true)
    setError(null)
    try {
      const got = await nameOnePart(url, index, total, taken, settings)
      // Into the draft, not onto the part: what the model says is a proposal,
      // and Save is how it becomes the part's name.
      setDraftName(got.name)
      if (Object.keys(got.details).length) setRows(toRows(got.details))
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setAsking(false)
    }
  }

  return (
    <div className="pd-back" onMouseDown={(e) => { if (e.target === e.currentTarget) leave() }}>
      <div className="pd" role="dialog" aria-modal="true" aria-label={`Part ${name}`}>
        <div className="pd-head">
          <h2>{name || 'Unnamed part'}</h2>
          <span className="pd-of">Part {index + 1} of {total}</span>
          {removed && <span className="pd-gone">Removed</span>}
          <button className="pd-x" title="Close" onClick={leave}>×</button>
        </div>

        <div className="pd-body">
          <Stage
            url={url} index={index} name={name} edit={edit}
            readout={(
              <TransformReadout
                title="Transform"
                poses={[edit ?? NO_EDIT]}
                extent={extent}
                onReset={resetEdit}
              />
            )}
          />

          <div className="pd-side">
            <div className="pd-block">
              <div className="pd-block-head">
                <span>Name &amp; description</span>
                {dirty && <span className="pd-dirty">Unsaved</span>}
              </div>

              <label className="pd-field">
                <span>Name</span>
                <input
                  value={draftName}
                  placeholder={originalName || 'Unnamed part'}
                  onChange={(e) => setDraftName(e.target.value)}
                />
              </label>

              <div className="pd-rows">
                {rows.map(([label, text], at) => (
                  <div className="pd-row" key={at}>
                    <input
                      className="pd-label"
                      value={label}
                      placeholder="Label"
                      aria-label={`Label of description field ${at + 1}`}
                      onChange={(e) => setRows((was) => was.map(
                        (row, i) => (i === at ? [e.target.value, row[1]] : row)))}
                    />
                    <button
                      className="pd-row-x"
                      title="Drop this field"
                      onClick={() => setRows((was) => was.filter((_, i) => i !== at))}
                    >
                      ×
                    </button>
                    <textarea
                      value={text}
                      rows={2}
                      placeholder="What this part is, does, or is made of"
                      aria-label={`Text of description field ${at + 1}`}
                      onChange={(e) => setRows((was) => was.map(
                        (row, i) => (i === at ? [row[0], e.target.value] : row)))}
                    />
                  </div>
                ))}
                {!rows.length && (
                  <p className="pd-empty">
                    Nothing is recorded about this part yet. Add a field, or ask
                    the model what it is.
                  </p>
                )}
              </div>

              <div className="pd-acts">
                <button
                  className="pd-add"
                  onClick={() => setRows((was) => [...was, ['', '']])}
                >
                  Add field
                </button>
                <button
                  className="pd-add"
                  disabled={!settings?.configured || asking}
                  title={settings?.configured
                    ? 'Render this part and ask the model what it is'
                    : 'Naming needs a provider and an API key, set on the Settings page'}
                  onClick={describe}
                >
                  {asking ? 'Asking…' : 'Describe with AI'}
                </button>
              </div>

              {error && <div className="error-box" style={{ marginTop: 10 }}>{error}</div>}

              <div className="pd-save">
                <button
                  className="go"
                  disabled={!dirty}
                  onClick={() => onSave(draftName.trim(), fromRows(rows))}
                >
                  Save name &amp; description
                </button>
                <button
                  className="head-reset"
                  disabled={!dirty}
                  onClick={() => { setDraftName(name); setRows(toRows(details)) }}
                >
                  Revert
                </button>
              </div>
            </div>

            <PartEditor
              names={[name]}
              scope="pd-edit"
              value={edit ?? NO_EDIT}
              extent={extent}
              onChange={onEdit}
              onReset={resetEdit}
            />

            <div className="pd-danger">
              {removed ? (
                <>
                  <span>
                    This part is left out of the saved model. It is still in the
                    file you opened, so putting it back costs nothing.
                  </span>
                  <button className="pd-restore" onClick={onRestore}>Restore part</button>
                </>
              ) : (
                <>
                  <span>
                    Deleting drops the part from the model you save, and from the
                    parts document with it. The file you opened is untouched.
                  </span>
                  <button className="pd-delete" onClick={() => { onRemove(); onClose() }}>
                    Delete part
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

/**
 * The part itself, large and turnable.
 *
 * The thumbnail beside the viewer is a still, which is all a thumbnail needs.
 * Here the studio's own canvas goes straight into the page instead, so dragging
 * turns the camera at the frame rate rather than encoding a JPEG per step --
 * and the camera is the only thing that moves. Turning the *part* is what the
 * rotate sliders below do, and that is an edit; this is just where you stand.
 */
function Stage({ url, index, name, edit, readout }: {
  url: string
  index: number
  name: string
  edit: PartEdit | undefined
  /** Where the part has been moved to, under the render of it. */
  readout: ReactNode
}) {
  const host = useRef<HTMLDivElement>(null)
  const studio = useRef<PartStudio | null>(null)
  const [ready, setReady] = useState(false)
  const [failed, setFailed] = useState(false)
  const [turned, setTurned] = useState(false)

  // One studio per model. It holds a WebGL context and a copy of the model on
  // the GPU, so it is closed rather than left to a GC, and its canvas is taken
  // back out of the page -- React did not put it there and will not remove it.
  useEffect(() => {
    let live = true
    setReady(false)
    setFailed(false)
    const opening = import('../partShots').then((m) => m.openStudio(url, SHOT_SIZE))
    opening.then((it) => {
      if (!live || !it) {
        it?.close()
        if (live) setFailed(true)
        return
      }
      studio.current = it
      host.current?.appendChild(it.canvas)
      setReady(true)
    }).catch(() => { if (live) setFailed(true) })

    return () => {
      live = false
      studio.current = null
      opening.then((it) => { it?.canvas.remove(); it?.close() }).catch(() => {})
    }
  }, [url])

  // `edit` is a fresh object on every render of the parent, so the effect is
  // keyed on its signature instead -- otherwise every keystroke in the name
  // field would re-stage the part and throw away the angle you had turned to.
  const touched = edit != null && isEdited(edit)
  const pose = touched ? JSON.stringify(edit) : ''
  const was = useRef(-1)

  useEffect(() => {
    if (!ready) return
    const it = studio.current
    // A part the viewer knows about that this parse does not is a mismatch
    // worth showing as a failure rather than a blank box.
    if (!it || index >= it.names.length) {
      setFailed(true)
      return
    }
    it.show(index, touched ? edit : undefined)
    // The studio keeps the angle across an edit to the same part, so the way
    // back to the resting view has to stay offered; a different part starts
    // square-on again and has nothing to go back to.
    if (was.current !== index) {
      was.current = index
      setTurned(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, index, pose])

  // Zooming must not scroll the page behind the dialog, and React registers
  // onWheel passively -- so preventDefault needs a listener of our own.
  useEffect(() => {
    const box = host.current
    if (!box) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      studio.current?.zoom(e.deltaY)
      setTurned(true)
    }
    box.addEventListener('wheel', onWheel, { passive: false })
    return () => box.removeEventListener('wheel', onWheel)
  }, [])

  // The drag is handled outside React: it redraws the canvas directly, and a
  // state change per pointermove would re-render the whole dialog for nothing.
  const drag = useRef<{ x: number; y: number } | null>(null)

  const onDown = (e: React.PointerEvent) => {
    if (!studio.current) return
    drag.current = { x: e.clientX, y: e.clientY }
    e.currentTarget.setPointerCapture(e.pointerId)
  }

  const onMove = (e: React.PointerEvent) => {
    const from = drag.current
    if (!from) return
    studio.current?.turn(e.clientX - from.x, e.clientY - from.y)
    drag.current = { x: e.clientX, y: e.clientY }
    setTurned(true)
  }

  const onUp = (e: React.PointerEvent) => {
    drag.current = null
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId)
    }
  }

  // Arrows turn and +/- zoom, so the view is not drag-only.
  const onKey = (e: React.KeyboardEvent) => {
    const step = e.shiftKey ? 60 : 20
    const by: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0], ArrowRight: [step, 0],
      ArrowUp: [0, -step], ArrowDown: [0, step],
    }
    if (by[e.key]) {
      e.preventDefault()
      studio.current?.turn(...by[e.key])
      setTurned(true)
    } else if (e.key === '+' || e.key === '=' || e.key === '-') {
      e.preventDefault()
      studio.current?.zoom(e.key === '-' ? 400 : -400)
      setTurned(true)
    }
  }

  return (
    <div className="pd-stage">
      <div
        ref={host}
        className="pd-shot"
        // Not role="img": it takes focus and answers the arrow keys, which is
        // not what a screen reader should be told to expect of a picture.
        role="group"
        tabIndex={0}
        aria-label={`${name}, on its own. Drag or use the arrow keys to turn it.`}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        onKeyDown={onKey}
      >
        {!ready && (
          <span className="part-shot-wait">{failed ? 'No preview' : 'Rendering…'}</span>
        )}
      </div>
      <div className="pd-cap">
        <span>{touched ? 'This part, with your edits' : 'This part, as the file has it'}</span>
        <span className="pd-cap-hint">Drag to turn · scroll to zoom</span>
        {turned && (
          <button
            className="pd-recentre"
            onClick={() => { studio.current?.recentre(); setTurned(false) }}
          >
            Recentre
          </button>
        )}
      </div>
      {readout}
    </div>
  )
}
