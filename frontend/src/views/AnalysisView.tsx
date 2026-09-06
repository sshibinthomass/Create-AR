import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  DEFAULT_OPTIONS, downloadUrl, formatCount, isEdited, NO_EDIT, previewUrl,
  type Capabilities, type Health, type NamerSettings, type PartDetails,
  type PartEdit, type PartsDoc,
} from '../api'
import Dropzone from '../components/Dropzone'
import PartEditor from '../components/PartEditor'
import PartPreview from '../components/PartPreview'
import { useConversion } from '../useConversion'
import { useNamer } from '../useNamer'

const ModelViewer = lazy(() => import('../components/ModelViewer'))

/** Formats that carry neither per-part names nor materials. */
const NAMELESS = new Set(['.stl', '.ply'])

/**
 * Take a model apart, name and adjust its pieces, save it back out.
 *
 * The model goes through the converter twice: once to GLB, which is what the
 * viewer can read and where the part names come from, and again on save with
 * the names and edits applied. The second pass re-uses the upload the server
 * already has, so only the changes travel.
 */
export default function AnalysisView({
  health, caps, active, settings, onOpenSettings,
}: {
  health: Health | null
  caps: Capabilities | null
  active: boolean
  /** Owned by the app, edited on the Settings page. Null until they load. */
  settings: NamerSettings | null
  onOpenSettings: () => void
}) {
  const [file, setFile] = useState<File | null>(null)
  const [parts, setParts] = useState<string[]>([])
  const [renames, setRenames] = useState<Record<string, string>>({})
  // What each part is, keyed by its name in the file -- the same key `renames`
  // uses, so both survive a save and come back together in a bundle.
  const [details, setDetails] = useState<Record<string, PartDetails>>({})
  // 'model' saves the converted file alone; 'bundle' zips it with parts.json.
  const [wrap, setWrap] = useState<'model' | 'bundle'>('model')
  const [edits, setEdits] = useState<Record<string, PartEdit>>({})
  const [reach, setReach] = useState(1)
  const [selected, setSelected] = useState<string[]>([])
  const [target, setTarget] = useState('.glb')
  const list = useRef<HTMLDivElement>(null)

  const analysis = useConversion()
  const exported = useConversion()
  const namer = useNamer()
  const clearExport = exported.setJob

  // A different model means a different set of parts; nothing carries over.
  const onParts = useCallback((names: string[], span: number) => {
    setParts(names)
    setReach(span)
    setRenames({})
    setDetails({})
    setEdits({})
    setSelected([])
    clearExport(null)
  }, [clearExport])

  // What the marked parts have in common, with a neutral value on any axis they
  // disagree about -- the panel is showing the group, not any one part.
  const shared = useMemo<PartEdit>(() => {
    const marked = selected.map((n) => edits[n] ?? NO_EDIT)
    if (marked.length === 1) return marked[0]
    if (!marked.length) return NO_EDIT
    const axis = (of: (e: PartEdit) => readonly number[], neutral: number) =>
      [0, 1, 2].map((i) =>
        marked.every((e) => of(e)[i] === of(marked[0])[i]) ? of(marked[0])[i] : neutral,
      ) as [number, number, number]
    const same = <T,>(of: (e: PartEdit) => T, neutral: T) =>
      marked.every((e) => of(e) === of(marked[0])) ? of(marked[0]) : neutral
    return {
      move: axis((e) => e.move, 0),
      rotate: axis((e) => e.rotate, 0),
      scale: axis((e) => e.scale, 1),
      material: same((e) => e.material, ''),
      color: same((e) => e.color, NO_EDIT.color),
    }
  }, [selected, edits])

  /**
   * Write a change from the panel onto every marked part.
   *
   * Only the fields the user actually moved are copied across: the panel shows
   * a neutral value wherever the group disagrees, so assigning the whole edit
   * would quietly flatten the parts that differ back to nothing.
   */
  const applyToMarked = useCallback((next: PartEdit) => {
    setEdits((all) => {
      const copy = { ...all }
      for (const name of selected) {
        const own = copy[name] ?? NO_EDIT
        const kept = (to: keyof Pick<PartEdit, 'move' | 'rotate' | 'scale'>) =>
          next[to].map((v, i) => (v === shared[to][i] ? own[to][i] : v)) as
            [number, number, number]
        copy[name] = {
          move: kept('move'),
          rotate: kept('rotate'),
          scale: kept('scale'),
          material: next.material === shared.material ? own.material : next.material,
          color: next.color === shared.color ? own.color : next.color,
        }
      }
      return copy
    })
  }, [selected, shared])

  /** Plain click replaces the marks; shift or ctrl/cmd adds to or drops from them. */
  const mark = useCallback((name: string | null, additive: boolean) => {
    setSelected((was) => {
      if (name === null) return additive ? was : []
      if (!additive) return [name]
      return was.includes(name) ? was.filter((n) => n !== name) : [...was, name]
    })
  }, [])

  // A part picked in the viewer has to be findable in a list that can be
  // hundreds of rows long. The list is scrolled directly rather than through
  // scrollIntoView, which would drag the whole page along with it.
  useEffect(() => {
    const box = list.current
    const row = box?.querySelector<HTMLElement>('.part-row.on')
    if (!box || !row) return
    const top = row.offsetTop - box.offsetTop
    if (top < box.scrollTop || top + row.offsetHeight > box.scrollTop + box.clientHeight) {
      box.scrollTop = top - (box.clientHeight - row.offsetHeight) / 2
    }
  }, [selected])

  /**
   * Put a bundle's own document back on the parts it describes.
   *
   * The model inside a bundle was written with the names already applied, so a
   * part's name in the file usually *is* the document's `name`; `originalName`
   * catches a bundle whose model was exported to a format that cannot carry
   * names at all, and the index is the last resort. Runs once per set of parts,
   * and only fills what the user has not already changed.
   */
  const doc = analysis.job?.partDoc ?? null
  const applied = useRef<PartsDoc | null>(null)
  useEffect(() => {
    if (!doc || !parts.length || applied.current === doc) return
    applied.current = doc
    const byName = new Map<string, PartsDoc['parts'][number]>()
    for (const entry of doc.parts) {
      if (entry.name) byName.set(entry.name, entry)
      if (entry.originalName) byName.set(entry.originalName, entry)
    }
    const names: Record<string, string> = {}
    const notes: Record<string, PartDetails> = {}
    parts.forEach((part, at) => {
      const entry = byName.get(part) ?? doc.parts.find((e) => e.index === at)
      if (!entry) return
      if (entry.name && entry.name !== part) names[part] = entry.name
      if (Object.keys(entry.details).length) notes[part] = entry.details
    })
    setRenames((was) => ({ ...names, ...was }))
    setDetails((was) => ({ ...notes, ...was }))
  }, [doc, parts])

  const outputs = useMemo(
    () => (caps?.formats ?? []).filter((f) => f.can_export),
    [caps],
  )

  const stats = analysis.job?.resultStats ?? null
  const preview = analysis.job?.status === 'done' && analysis.job.hasPreview
    ? previewUrl(analysis.job.id)
    : null
  // One part at a time in the card: with several marked the panel below the
  // list is already showing what they have in common, and stacking descriptions
  // would bury the model.
  const shown = useMemo(() => {
    if (selected.length !== 1) return null
    const part = selected[0]
    const at = parts.indexOf(part)
    if (at < 0) return null
    return { at, name: renames[part] ?? part, details: details[part] ?? {} }
  }, [selected, parts, renames, details])

  const renamed = Object.keys(renames).length
  const adjusted = Object.values(edits).filter(isEdited).length


  function analyse() {
    if (!file) return
    setParts([])
    setRenames({})
    setDetails({})
    setEdits({})
    setSelected([])
    exported.setJob(null)
    analysis.start(file, '.glb', DEFAULT_OPTIONS)
  }

  /**
   * Hand every part to the model and write back what it says they are.
   *
   * The answers arrive chunk by chunk and are folded straight into `renames`,
   * so they show up in the list as they land and every row keeps its own undo.
   * A name that matches the file's own is not a rename, the same rule the
   * name field itself follows.
   */
  function autoName() {
    if (!preview || !settings) return
    namer.run(preview, parts, settings, (found, told) => {
      setRenames((was) => {
        const copy = { ...was }
        for (const [original, name] of Object.entries(found)) {
          if (name === original) delete copy[original]
          else copy[original] = name
        }
        return copy
      })
      if (Object.keys(told).length) setDetails((was) => ({ ...was, ...told }))
    })
  }

  /** Every part, as the document records it: its old name, its new one, and what it is. */
  const described = useMemo(() => parts.map((name, index) => ({
    index,
    originalName: name,
    name: renames[name] ?? name,
    details: details[name] ?? {},
  })), [parts, renames, details])

  function save() {
    if (!analysis.job) return
    exported.startFrom(analysis.job.id, target, {
      ...DEFAULT_OPTIONS,
      archive_entry: analysis.job.archiveEntry ?? '',
      renames,
      edits,
      bundle: wrap === 'bundle',
      part_details: wrap === 'bundle' ? described : undefined,
    })
  }

  return (
    <div className="analysis">
      {/* Loading the model spans the width; the parts and the viewer share the
          room below it, which is where the work actually happens. */}
      <section className="card source">
        <div className="card-head"><h2>Model to inspect</h2></div>
        <div className="card-body source-body">
          <Dropzone
            file={file}
            accept={caps?.inputs ?? []}
            maxBytes={health?.maxUploadBytes ?? 512 * 1024 * 1024}
            onSelect={(f) => { setFile(f); analysis.setError(null) }}
            onReject={analysis.setError}
          />
          <div className="note">
            Every part the model was authored with is pulled outward from the
            centre of the assembly. Click a part — in the viewer or in the list
            — to see its name and pick it out, and shift-click to mark several
            and move them together. Models exported as one merged mesh have
            nothing to separate.
          </div>
          <button
            className="go"
            disabled={!file || !health?.ok || analysis.busy}
            onClick={analyse}
          >
            {analysis.uploading
              ? `Uploading ${analysis.uploadPct}%`
              : analysis.busy ? 'Preparing…' : 'Analyse model'}
          </button>
        </div>
        {analysis.job?.status === 'done' && (
          <div className="stats">
            <div className="stat"><div className="k">Parts</div><div className="v">{formatCount(parts.length)}</div></div>
            <div className="stat"><div className="k">Meshes</div><div className="v">{formatCount(stats?.meshes)}</div></div>
            <div className="stat"><div className="k">Triangles</div><div className="v">{formatCount(stats?.triangles)}</div></div>
            <div className="stat"><div className="k">Materials</div><div className="v">{formatCount(stats?.materials)}</div></div>
          </div>
        )}
      </section>

      {analysis.error && <div className="error-box source">{analysis.error}</div>}

      <div className="col">
        {parts.length > 0 && (
          <section className="card">
            <div className="card-head">
              <h2>Parts</h2>
              {(renamed > 0 || adjusted > 0 || selected.length > 1) && (
                <span className="head-note">
                  {[selected.length > 1 && `${selected.length} marked`,
                    renamed && `${renamed} renamed`,
                    adjusted && `${adjusted} edited`]
                    .filter(Boolean).join(' · ')}
                </span>
              )}
              {renamed > 0 && (
                <button
                  className="head-reset"
                  title="Put every part's name back to the one in the file"
                  onClick={() => setRenames({})}
                >
                  Reset names
                </button>
              )}
              {adjusted > 0 && (
                <button
                  className="head-reset"
                  title="Undo every move, rotation, scale and material"
                  onClick={() => setEdits({})}
                >
                  Reset edits
                </button>
              )}
            </div>
            <div className="name-bar">
              <button
                className="go name-go"
                disabled={!preview || !settings?.configured || namer.busy || analysis.busy}
                onClick={autoName}
              >
                {namer.busy
                  ? `${namer.step}… ${namer.done}/${namer.total}`
                  : 'Name parts with AI'}
              </button>
              {namer.busy ? (
                <button className="head-reset" onClick={namer.stop}>Stop</button>
              ) : (
                <button
                  className="head-reset"
                  title="Provider, batching and the instructions"
                  onClick={onOpenSettings}
                >
                  Settings
                </button>
              )}
            </div>

            {namer.busy && (
              <div className="name-prog">
                <div className={`bar${namer.total ? '' : ' indet'}`}>
                  <i style={{ width: `${namer.total ? (namer.done / namer.total) * 100 : 0}%` }} />
                </div>
              </div>
            )}

            {settings && !settings.configured && !namer.busy && (
              <div className="name-prog">
                <div className="note" style={{ marginTop: 0 }}>
                  Naming needs a provider and an API key. Pick one in{' '}
                  <button className="link" onClick={onOpenSettings}>Settings</button> —
                  they are kept on the server, not in the browser.
                </div>
              </div>
            )}

            {namer.error && (
              <div className="name-prog">
                <div className="error-box">{namer.error}</div>
              </div>
            )}

            <div className="parts" ref={list}>
              {parts.map((name, i) => (
                <div
                  key={`${name}-${i}`}
                  className={`part-row${selected.includes(name) ? ' on' : ''}`}
                  onClick={(e) => mark(name, e.shiftKey || e.ctrlKey || e.metaKey)}
                >
                  <span className="part-n">{i + 1}</span>
                  <input
                    value={renames[name] ?? name}
                    aria-label={`Name of part ${name || i + 1}`}
                    onChange={(e) => {
                      const next = e.target.value
                      setRenames((r) => {
                        const copy = { ...r }
                        if (next === name) delete copy[name]
                        else copy[name] = next
                        return copy
                      })
                    }}
                  />
                  {isEdited(edits[name]) && (
                    <span className="part-edited" title="This part has been moved, resized or restyled">✎</span>
                  )}
                  {renames[name] !== undefined && (
                    <button
                      className="part-undo"
                      title={`Restore "${name}"`}
                      onClick={() => setRenames((r) => {
                        const copy = { ...r }
                        delete copy[name]
                        return copy
                      })}
                    >
                      ↺
                    </button>
                  )}
                </div>
              ))}
            </div>
            {selected.length > 0 && (
              <PartEditor
                names={selected.map((n) => renames[n] ?? n)}
                value={shared}
                extent={reach}
                onChange={applyToMarked}
                onReset={() => setEdits((all) => {
                  const copy = { ...all }
                  for (const name of selected) delete copy[name]
                  return copy
                })}
              />
            )}

            <div className="card-body">
              <div className="opt-row">
                <label>Export</label>
                <div className="ctl wrap-pick">
                  <button
                    className={`wrap-opt${wrap === 'model' ? ' sel' : ''}`}
                    onClick={() => setWrap('model')}
                  >
                    Model only
                  </button>
                  <button
                    className={`wrap-opt${wrap === 'bundle' ? ' sel' : ''}`}
                    onClick={() => setWrap('bundle')}
                  >
                    Model + details
                  </button>
                </div>
              </div>

              <div className="opt-row">
                <label htmlFor="an-target">Save as</label>
                <div className="ctl">
                  <select id="an-target" value={target} onChange={(e) => setTarget(e.target.value)}>
                    {outputs.map((f) => (
                      <option key={f.ext} value={f.ext}>
                        {f.ext.slice(1).toUpperCase()} — {f.label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              {wrap === 'bundle' && (
                <div className="note">
                  A ZIP holding the {target.slice(1).toUpperCase()} and a{' '}
                  <code>parts.json</code> describing every part. Drop that ZIP
                  back in and the app recognises its own document, putting the
                  names and descriptions back on the parts they belong to.
                  {described.every((d) => !Object.keys(d.details).length) && (
                    <> Nothing has been described yet — the document will carry
                    the names alone until you run the namer with descriptions on.</>
                  )}
                </div>
              )}

              {NAMELESS.has(target) && (
                <div className="note">
                  {target.slice(1).toUpperCase()} stores a single unnamed, unshaded
                  mesh, so the names and materials are lost on the way out — though
                  the moves, rotations and scales still apply. GLB, USD, FBX and OBJ
                  all keep the lot.
                </div>
              )}

              {exported.error && <div className="error-box" style={{ marginTop: 12 }}>{exported.error}</div>}
              {exported.job?.status === 'error' && (
                <div className="error-box" style={{ marginTop: 12 }}>{exported.job.error}</div>
              )}
              {exported.job?.status === 'done' && exported.job.warnings.length > 0 && (
                <div className="warn-box">
                  {exported.job.warnings.map((w, i) => <div key={i}>{w}</div>)}
                </div>
              )}

              <button
                className="go"
                style={{ marginTop: 12 }}
                disabled={analysis.busy || exported.busy}
                onClick={save}
              >
                {exported.busy
                  ? `Saving… ${exported.job?.progress ?? 0}%`
                  : wrap === 'bundle'
                    ? `Save ${target.slice(1).toUpperCase()} + details as ZIP`
                    : `Save as ${target.slice(1).toUpperCase()}`}
              </button>

              {exported.job?.status === 'done' && (
                <a className="dl" href={downloadUrl(exported.job.id)} download>
                  Download {exported.job.downloadName}
                </a>
              )}
            </div>
          </section>
        )}
      </div>

      <div className="col">
        <section className="card viewer-card">
          {/* The selected part on its own, against the assembly on the right:
              a box around a trim piece says where it is, not what it is. */}
          {shown && preview && (
            <PartPreview
              url={preview}
              index={shown.at}
              name={shown.name}
              edit={edits[selected[0]]}
            />
          )}

          {/* What the selected part is, over the model rather than beside it:
              the name is already on the part, and this is the rest of it. */}
          {shown && (
            <aside className="part-card">
              <div className="part-card-head">
                <h3>{shown.name}</h3>
                <button
                  className="part-card-x"
                  title="Hide these details"
                  onClick={() => setSelected([])}
                >
                  ×
                </button>
              </div>
              {Object.keys(shown.details).length ? (
                <dl className="part-facts">
                  {Object.entries(shown.details).map(([label, text]) => (
                    <div key={label}>
                      <dt>{label}</dt>
                      <dd>{text}</dd>
                    </div>
                  ))}
                </dl>
              ) : (
                <p className="part-card-empty">
                  Nothing is recorded about this part yet. Run <b>Name parts
                  with AI</b> with descriptions turned on, or open a bundle that
                  already has them.
                </p>
              )}
            </aside>
          )}

          <Suspense fallback={<div className="viewer"><div className="viewer-empty">Loading viewer…</div></div>}>
            <ModelViewer
              key={preview ?? 'empty'}
              url={preview}
              explodeOpen
              labels={renames}
              edits={edits}
              selected={selected}
              onSelect={mark}
              onEdit={(changes) => setEdits((e) => ({ ...e, ...changes }))}
              onParts={onParts}
              active={active}
              placeholder={
                analysis.job?.status === 'error'
                  ? 'That model could not be read — see the message on the left.'
                  : analysis.busy
                    ? 'Preparing the model…'
                    : 'Upload a model to take it apart.'
              }
            />
          </Suspense>

          {(analysis.busy || analysis.uploading) && (
            <div className="card-body">
              <div className="prog-row">
                <span>{analysis.uploading ? 'Uploading' : (analysis.job?.step ?? 'Working')}</span>
                <span>{analysis.uploading ? `${analysis.uploadPct}%` : `${analysis.job?.progress ?? 0}%`}</span>
              </div>
              <div className={`bar${!analysis.uploading && analysis.job?.status === 'queued' ? ' indet' : ''}`}>
                <i style={{ width: `${analysis.uploading ? analysis.uploadPct : (analysis.job?.progress ?? 0)}%` }} />
              </div>
            </div>
          )}
        </section>
      </div>
    </div>
  )
}
