import { lazy, Suspense, useCallback, useMemo, useState } from 'react'
import {
  DEFAULT_OPTIONS, downloadUrl, formatBytes, formatCount, previewUrl,
  type Capabilities, type ConvertOptions, type Health, type Job,
} from '../api'
import Dropzone from '../components/Dropzone'
import OptionsPanel from '../components/OptionsPanel'
import { useConversion } from '../useConversion'

// three.js is ~900 kB and is only needed once a preview exists, so it is split
// out of the initial bundle.
const ModelViewer = lazy(() => import('../components/ModelViewer'))

const GROUPS: { label: string; exts: string[] }[] = [
  { label: 'AR & Web', exts: ['.glb', '.usdz', '.gltf'] },
  { label: 'Interchange', exts: ['.fbx', '.obj', '.abc'] },
  { label: 'Mesh', exts: ['.stl', '.ply'] },
  { label: 'USD variants', exts: ['.usdc', '.usda', '.usd'] },
]

export default function ConvertView({ health, caps, active }: {
  health: Health | null
  caps: Capabilities | null
  active: boolean
}) {
  const [file, setFile] = useState<File | null>(null)
  const [target, setTarget] = useState('.glb')
  const [options, setOptions] = useState<ConvertOptions>(DEFAULT_OPTIONS)
  const [history, setHistory] = useState<Job[]>([])

  const remember = useCallback((done: Job) => {
    setHistory((h) => [done, ...h.filter((j) => j.id !== done.id)].slice(0, 12))
  }, [])
  const { job, setJob, uploading, uploadPct, error, setError, start, busy } = useConversion(remember)

  const inputExts = caps?.inputs ?? []
  const outputs = useMemo(
    () => new Map((caps?.formats ?? []).filter((f) => f.can_export).map((f) => [f.ext, f])),
    [caps],
  )

  const sourceExt = useMemo(() => {
    if (!file) return ''
    const dot = file.name.lastIndexOf('.')
    const raw = dot >= 0 ? file.name.slice(dot).toLowerCase() : ''
    return caps?.aliases?.[raw] ?? raw
  }, [file, caps])

  // Categories come from /api/formats so the UI never hardcodes the list.
  const categoryOf = useMemo(() => {
    const m = new Map((caps?.formats ?? []).map((f) => [f.ext, f.category]))
    return (ext: string) => m.get(ext)
  }, [caps])

  const isCadInput = categoryOf(sourceExt) === 'cad'
  const isArchiveInput = categoryOf(sourceExt) === 'archive'
  const canConvert = !!file && !!health?.ok && !busy && sourceExt !== target

  const convert = (entryOverride?: string) => {
    if (!file) return
    start(file, target, entryOverride ? { ...options, archive_entry: entryOverride } : options)
  }

  const targetFmt = outputs.get(target)
  const stats = job?.resultStats ?? null
  const preview = job?.status === 'done' && job.hasPreview ? previewUrl(job.id) : null

  return (
    <div className="layout">
      {/* ---------------- left: the form ---------------- */}
      <div className="col">
        <section className="card">
          <div className="card-head"><span className="step-n">1</span><h2>Source model</h2></div>
          <div className="card-body">
            <Dropzone
              file={file}
              accept={inputExts}
              maxBytes={health?.maxUploadBytes ?? 512 * 1024 * 1024}
              onSelect={(f) => { setFile(f); setError(null) }}
              onReject={setError}
            />
            {isCadInput && (
              <div className="note">
                CAD B-rep is tessellated with OpenCASCADE before Blender sees it.
              </div>
            )}
            {isArchiveInput && (
              <div className="note">
                The model is found inside automatically, wherever it sits and
                however deeply it is nested — textures and sidecars included, so
                a zipped OBJ keeps its materials.
              </div>
            )}
          </div>
        </section>

        <section className="card">
          <div className="card-head"><span className="step-n">2</span><h2>Convert to</h2></div>
          <div className="card-body">
            {GROUPS.map((g) => {
              const items = g.exts.filter((e) => outputs.has(e))
              if (!items.length) return null
              return (
                <div key={g.label}>
                  <div className="group-label">{g.label}</div>
                  <div className="fmt-grid">
                    {items.map((ext) => {
                      const f = outputs.get(ext)!
                      const same = ext === sourceExt
                      return (
                        <button
                          key={ext}
                          className={`fmt${target === ext ? ' sel' : ''}`}
                          disabled={same}
                          title={same ? 'Source is already this format' : f.note || f.label}
                          onClick={() => setTarget(ext)}
                        >
                          <div className="e">{ext.slice(1).toUpperCase()}</div>
                          <div className="l">{f.label}</div>
                        </button>
                      )
                    })}
                  </div>
                </div>
              )
            })}
            {targetFmt?.note && <div className="note">{targetFmt.note}</div>}
          </div>
        </section>

        <section className="card">
          <div className="card-body">
            <OptionsPanel
              value={options}
              onChange={setOptions}
              targetExt={target}
              isCadInput={isCadInput}
            />
          </div>
        </section>

        {error && <div className="error-box">{error}</div>}

        <button className="go" disabled={!canConvert} onClick={() => convert()}>
          {uploading
            ? `Uploading ${uploadPct}%`
            : busy
              ? 'Converting…'
              : sourceExt && sourceExt === target
                ? 'Pick a different target format'
                : `Convert to ${target.slice(1).toUpperCase()}`}
        </button>
      </div>

      {/* ---------------- right: the result ---------------- */}
      <div className="col">
        <section className="card">
          <Suspense fallback={<div className="viewer"><div className="viewer-empty">Loading viewer…</div></div>}>
            <ModelViewer
              key={preview ?? 'empty'}
              url={preview}
              active={active}
              placeholder={
                job?.status === 'error'
                  ? 'Conversion failed — see the message below.'
                  : busy
                    ? 'Converting…'
                    : 'Your converted model will appear here.'
              }
            />
          </Suspense>

          {(busy || uploading) && (
            <div className="card-body" style={{ borderBottom: '1px solid var(--line-soft)' }}>
              <div className="prog-row">
                <span>{uploading ? 'Uploading' : (job?.step ?? 'Working')}</span>
                <span>{uploading ? `${uploadPct}%` : `${job?.progress ?? 0}%`}</span>
              </div>
              <div className={`bar${!uploading && job?.status === 'queued' ? ' indet' : ''}`}>
                <i style={{ width: `${uploading ? uploadPct : (job?.progress ?? 0)}%` }} />
              </div>
            </div>
          )}

          {job?.status === 'done' && (
            <>
              <div className="stats">
                <div className="stat"><div className="k">Triangles</div><div className="v">{formatCount(stats?.triangles)}</div></div>
                <div className="stat"><div className="k">Vertices</div><div className="v">{formatCount(stats?.vertices)}</div></div>
                <div className="stat"><div className="k">Meshes</div><div className="v">{formatCount(stats?.meshes)}</div></div>
                <div className="stat"><div className="k">Materials</div><div className="v">{formatCount(stats?.materials)}</div></div>
                <div className="stat"><div className="k">Size</div><div className="v">{formatBytes(job.outputSize)}</div></div>
              </div>
              <div className="card-body">
                {stats?.dimensions && (
                  <div style={{ fontSize: 12, color: 'var(--dim)', marginBottom: 10 }}>
                    Bounding box: {stats.dimensions.map((d) => d.toFixed(3)).join(' × ')} m
                  </div>
                )}
                {job.archiveEntries.length > 1 && (
                  <div className="entries">
                    <div className="entries-head">
                      {job.archiveEntries.length} models in this archive — converted{' '}
                      <code>{job.archiveEntry}</code>
                    </div>
                    {job.archiveEntries
                      .filter((e) => e !== job.archiveEntry)
                      .slice(0, 8)
                      .map((e) => (
                        <button
                          key={e}
                          className="entry"
                          disabled={busy || !file}
                          onClick={() => convert(e)}
                          title={`Convert ${e} instead`}
                        >
                          <span className="entry-path">{e}</span>
                          <span className="entry-go">convert this →</span>
                        </button>
                      ))}
                  </div>
                )}
                {job.warnings.map((w, i) => <div className="warn-box" key={i} style={{ marginBottom: 8 }}>{w}</div>)}
                <a className="dl" href={downloadUrl(job.id)} download>
                  Download {job.downloadName}
                </a>
              </div>
            </>
          )}

          {job?.status === 'error' && (
            <div className="card-body">
              <div className="error-box">{job.error}</div>
              {job.log.length > 0 && (
                <pre className="log" style={{ marginTop: 12 }}>{job.log.slice(-30).join('\n')}</pre>
              )}
            </div>
          )}
        </section>

        {history.length > 0 && (
          <section className="card">
            <div className="card-head"><h2>Recent conversions</h2></div>
            <div className="hist">
              {history.map((h) => (
                <button
                  key={h.id}
                  className={`hist-item${job?.id === h.id ? ' active' : ''}`}
                  onClick={() => setJob(h)}
                >
                  <span className={`pill ${h.status}`}>{h.status}</span>
                  <span className="nm">{h.filename}</span>
                  <span className="arrow">
                    {h.sourceExt.slice(1)} → {h.targetExt.slice(1)}
                  </span>
                </button>
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  )
}
