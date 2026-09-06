import { useEffect, useState } from 'react'
import { NO_EDIT, type NamerSettings, type PartDetails, type PartEdit } from '../api'
import { nameOnePart } from '../useNamer'
import { usePartShot } from '../usePartShot'
import PartEditor from './PartEditor'

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
          <Stage url={url} index={index} name={name} edit={edit} />

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
              onReset={onResetEdit}
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

/** The part itself, rendered large. Its own component so a redraw stays local. */
function Stage({ url, index, name, edit }: {
  url: string
  index: number
  name: string
  edit: PartEdit | undefined
}) {
  const { data, failed, touched } = usePartShot(url, index, edit, SHOT_SIZE)

  return (
    <div className="pd-stage">
      <div className="pd-shot">
        {data ? (
          <img src={`data:image/jpeg;base64,${data}`} alt={`${name}, on its own`} />
        ) : (
          <span className="part-shot-wait">{failed ? 'No preview' : 'Rendering…'}</span>
        )}
      </div>
      <div className="pd-cap">
        {touched ? 'This part, with your edits' : 'This part, as the file has it'}
      </div>
    </div>
  )
}
