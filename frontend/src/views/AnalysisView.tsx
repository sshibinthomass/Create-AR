import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  DEFAULT_OPTIONS, downloadUrl, formatCount, previewUrl,
  type Capabilities, type Health,
} from '../api'
import Dropzone from '../components/Dropzone'
import { useConversion } from '../useConversion'

const ModelViewer = lazy(() => import('../components/ModelViewer'))

/** Formats that carry no per-part names, whatever the parts are called here. */
const NAMELESS = new Set(['.stl', '.ply'])

/**
 * Take a model apart, name its pieces, save it back out.
 *
 * The model goes through the converter twice: once to GLB, which is what the
 * viewer can read and where the part names come from, and again on save with
 * the new names applied. The second pass re-uses the upload the server already
 * has, so only the names travel.
 */
export default function AnalysisView({ health, caps, active }: {
  health: Health | null
  caps: Capabilities | null
  active: boolean
}) {
  const [file, setFile] = useState<File | null>(null)
  const [parts, setParts] = useState<string[]>([])
  const [renames, setRenames] = useState<Record<string, string>>({})
  const [selected, setSelected] = useState<string | null>(null)
  const [target, setTarget] = useState('.glb')
  const list = useRef<HTMLDivElement>(null)

  const analysis = useConversion()
  const exported = useConversion()
  const clearExport = exported.setJob

  // A different model means a different set of parts; nothing carries over.
  const onParts = useCallback((names: string[]) => {
    setParts(names)
    setRenames({})
    setSelected(null)
    clearExport(null)
  }, [clearExport])

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

  const outputs = useMemo(
    () => (caps?.formats ?? []).filter((f) => f.can_export),
    [caps],
  )

  const stats = analysis.job?.resultStats ?? null
  const preview = analysis.job?.status === 'done' && analysis.job.hasPreview
    ? previewUrl(analysis.job.id)
    : null
  const renamed = Object.keys(renames).length

  function analyse() {
    if (!file) return
    setParts([])
    setRenames({})
    setSelected(null)
    exported.setJob(null)
    analysis.start(file, '.glb', DEFAULT_OPTIONS)
  }

  function save() {
    if (!analysis.job) return
    exported.startFrom(analysis.job.id, target, {
      ...DEFAULT_OPTIONS,
      archive_entry: analysis.job.archiveEntry ?? '',
      renames,
    })
  }

  return (
    <div className="layout">
      <div className="col">
        <section className="card">
          <div className="card-head"><h2>Model to inspect</h2></div>
          <div className="card-body">
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
              — to see its name and pick it out. Models exported as one merged
              mesh have nothing to separate.
            </div>
          </div>
        </section>

        {analysis.error && <div className="error-box">{analysis.error}</div>}

        <button
          className="go"
          disabled={!file || !health?.ok || analysis.busy}
          onClick={analyse}
        >
          {analysis.uploading
            ? `Uploading ${analysis.uploadPct}%`
            : analysis.busy ? 'Preparing…' : 'Analyse model'}
        </button>

        {analysis.job?.status === 'done' && (
          <section className="card">
            <div className="stats">
              <div className="stat"><div className="k">Parts</div><div className="v">{formatCount(parts.length)}</div></div>
              <div className="stat"><div className="k">Meshes</div><div className="v">{formatCount(stats?.meshes)}</div></div>
              <div className="stat"><div className="k">Triangles</div><div className="v">{formatCount(stats?.triangles)}</div></div>
              <div className="stat"><div className="k">Materials</div><div className="v">{formatCount(stats?.materials)}</div></div>
            </div>
          </section>
        )}

        {parts.length > 0 && (
          <section className="card">
            <div className="card-head">
              <h2>Parts</h2>
              {renamed > 0 && <span className="head-note">{renamed} renamed</span>}
            </div>
            <div className="parts" ref={list}>
              {parts.map((name, i) => (
                <div
                  key={`${name}-${i}`}
                  className={`part-row${selected === name ? ' on' : ''}`}
                  onClick={() => setSelected(name)}
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
            <div className="card-body">
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

              {NAMELESS.has(target) && (
                <div className="note">
                  {target.slice(1).toUpperCase()} stores a single unnamed mesh, so
                  the names are lost on the way out. GLB, USD, FBX and OBJ all keep
                  them.
                </div>
              )}

              {exported.error && <div className="error-box" style={{ marginTop: 12 }}>{exported.error}</div>}
              {exported.job?.status === 'error' && (
                <div className="error-box" style={{ marginTop: 12 }}>{exported.job.error}</div>
              )}

              <button
                className="go"
                style={{ marginTop: 12 }}
                disabled={analysis.busy || exported.busy}
                onClick={save}
              >
                {exported.busy
                  ? `Saving… ${exported.job?.progress ?? 0}%`
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
        <section className="card">
          <Suspense fallback={<div className="viewer"><div className="viewer-empty">Loading viewer…</div></div>}>
            <ModelViewer
              key={preview ?? 'empty'}
              url={preview}
              explodeOpen
              labels={renames}
              selected={selected}
              onSelect={setSelected}
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
