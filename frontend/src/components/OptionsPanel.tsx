import { useState, type ReactNode } from 'react'
import { formatCount, type ConvertOptions, type ReduceMode } from '../api'

interface Props {
  value: ConvertOptions
  onChange: (next: ConvertOptions) => void
  targetExt: string
  isCadInput: boolean
  /** Triangles in the last conversion of this model, to size the budget against. */
  sourceTriangles?: number | null
}

function Toggle({ on, onToggle }: { on: boolean; onToggle: (v: boolean) => void }) {
  return (
    <label className="switch">
      <input type="checkbox" checked={on} onChange={(e) => onToggle(e.target.checked)} />
      <span />
    </label>
  )
}

/**
 * One option: what it is called, one line on what it does, and its control.
 *
 * The hint is not optional by design. A panel of bare labels is only readable
 * to someone who already knows what the labels mean, which is the one person
 * who does not need to read it.
 */
function Row({ label, hint, htmlFor, children }: {
  label: string
  hint: string
  htmlFor?: string
  children: ReactNode
}) {
  return (
    <div className="opt-row">
      <div className="lbl">
        <label htmlFor={htmlFor}>{label}</label>
        <span className="hint">{hint}</span>
      </div>
      {children}
    </div>
  )
}

const TEXTURE_LIMITS = [
  { v: 0, label: 'Leave as-is' },
  { v: 256, label: '256 px' },
  { v: 512, label: '512 px' },
  { v: 1024, label: '1024 px' },
  { v: 2048, label: '2048 px' },
  { v: 4096, label: '4096 px' },
]

export default function OptionsPanel({
  value, onChange, targetExt, isCadInput, sourceTriangles,
}: Props) {
  const [open, setOpen] = useState(false)
  // Which way the triangle reduction is aimed. Held here rather than in the
  // options because the backend only needs the one that is in force: a budget
  // of 0 means the percentage is driving.
  const [reduceMode, setReduceMode] = useState<ReduceMode>('percent')

  const set = <K extends keyof ConvertOptions>(key: K, v: ConvertOptions[K]) =>
    onChange({ ...value, [key]: v })

  const isUsd = ['.usdz', '.usdc', '.usda', '.usd'].includes(targetExt)
  const isGltf = targetExt === '.glb' || targetExt === '.gltf'

  const pickMode = (mode: ReduceMode) => {
    setReduceMode(mode)
    // Only one of the two is ever sent; the other goes back to its no-op value.
    onChange(mode === 'budget'
      ? { ...value, decimate: 1, tri_budget: value.tri_budget || 150_000 }
      : { ...value, tri_budget: 0 })
  }

  // Everything that reduces geometry does it with a modifier, so all of it is
  // thrown away on export unless modifiers are applied. Worth saying up front
  // rather than letting the conversion come back unchanged.
  const reductions = [
    value.decimate < 1 && 'Simplify',
    value.tri_budget > 0 && 'the triangle budget',
    value.weld > 0 && 'Merge vertices',
    value.triangulate && 'Triangulate faces',
  ].filter(Boolean) as string[]
  const droppedByModifiers = !value.apply_modifiers && reductions.length > 0

  return (
    <div className="opts">
      <button className="disclosure" onClick={() => setOpen(!open)}>
        <span>Conversion options</span>
        <span>{open ? '−' : '+'}</span>
      </button>

      {open && (
        <>
          <div className="group-label">Placement</div>

          <Row
            label="Scale" htmlFor="opt-scale"
            hint="Multiplies the model's size. 0.001 turns millimetres into metres."
          >
            <div className="ctl">
              <input
                id="opt-scale" type="number" min={0.0001} max={10000} step={0.1}
                value={value.scale}
                onChange={(e) => set('scale', Math.max(0.0001, Number(e.target.value) || 1))}
              />
            </div>
          </Row>

          <Row
            label="Recentre" htmlFor="opt-center"
            hint="Where the model sits relative to the origin. On the floor is what AR expects."
          >
            <div className="ctl">
              <select
                id="opt-center" value={value.center}
                onChange={(e) => set('center', e.target.value as ConvertOptions['center'])}
              >
                <option value="none">Leave as-is</option>
                <option value="origin">Bounding box centre</option>
                <option value="floor">On the floor</option>
              </select>
            </div>
          </Row>

          {/* ---------------- geometry ---------------- */}
          <div className="group-label">Reduce geometry</div>

          <Row
            label="Aim by" htmlFor="opt-mode"
            hint="Whether to give a share of the faces to keep, or a triangle count to hit."
          >
            <div className="ctl">
              <select
                id="opt-mode" value={reduceMode}
                onChange={(e) => pickMode(e.target.value as ReduceMode)}
              >
                <option value="percent">Percentage</option>
                <option value="budget">Triangle budget</option>
              </select>
            </div>
          </Row>

          {reduceMode === 'percent' ? (
            <Row
              label={`Simplify to ${Math.round(value.decimate * 100)}%`} htmlFor="opt-dec"
              hint="Keeps this share of the faces on every mesh. Blunt: small parts suffer most."
            >
              <div className="ctl">
                <input
                  id="opt-dec" type="range" min={0.05} max={1} step={0.05}
                  value={value.decimate}
                  onChange={(e) => set('decimate', Number(e.target.value))}
                />
              </div>
            </Row>
          ) : (
            <Row
              label="Target triangles" htmlFor="opt-budget"
              hint="The total to land on across the whole model."
            >
              <div className="ctl">
                <input
                  id="opt-budget" type="number" min={100} max={100000000} step={10000}
                  value={value.tri_budget}
                  onChange={(e) => set('tri_budget', Math.max(0, Number(e.target.value) || 0))}
                />
              </div>
            </Row>
          )}

          {reduceMode === 'budget' && (
            <div className="note">
              Meshes of 64 triangles or fewer are left alone; the rest share the reduction,
              so it comes out of the parts that hold the triangles rather than flattening
              every small bolt equally.
              {sourceTriangles ? ` This model came in at ${formatCount(sourceTriangles)}.` : ''}
            </div>
          )}

          <Row
            label="Merge meshes" htmlFor="opt-merge"
            hint="Joins meshes together to cut draw calls. Loses the individual part names."
          >
            <div className="ctl">
              <select
                id="opt-merge" value={value.merge}
                onChange={(e) => set('merge', e.target.value as ConvertOptions['merge'])}
              >
                <option value="none">Keep separate</option>
                <option value="material">One per material</option>
                <option value="all">All into one</option>
              </select>
            </div>
          </Row>

          {value.merge !== 'none' && (
            <div className="note">
              With the names gone, the parts list, <code>parts.json</code> and any animation
              have nothing left to attach to. A model that carries clips is left unmerged.
            </div>
          )}

          <Row
            label="Merge vertices within" htmlFor="opt-weld"
            hint="Welds vertices closer than this, in model units. Fixes CAD and STL, which repeat a vertex per face. Try 0.001."
          >
            <div className="ctl">
              <input
                id="opt-weld" type="number" min={0} max={1000} step={0.0001}
                value={value.weld}
                onChange={(e) => set('weld', Math.max(0, Number(e.target.value) || 0))}
              />
            </div>
          </Row>

          <Row
            label="Drop unused data"
            hint="Material slots no face uses, and vertices and edges no face touches."
          >
            <Toggle on={value.clean} onToggle={(v) => set('clean', v)} />
          </Row>

          {value.clean && (
            <div className="note">
              Worth little on most uploads — the glTF, OBJ and STL importers already discard
              both on the way in. A <code>.blend</code> keeps whatever its author left in it.
            </div>
          )}

          <Row
            label="Triangulate faces"
            hint="Turns quads and n-gons into triangles. Some engines need it."
          >
            <Toggle on={value.triangulate} onToggle={(v) => set('triangulate', v)} />
          </Row>

          {/* ---------------- textures ---------------- */}
          <div className="group-label">Reduce textures</div>

          <Row
            label="Max resolution" htmlFor="opt-tex"
            hint="Caps the longest edge of every image. Usually the single biggest saving."
          >
            <div className="ctl">
              <select
                id="opt-tex" value={value.texture_limit}
                onChange={(e) => set('texture_limit', Number(e.target.value))}
              >
                {TEXTURE_LIMITS.map((t) => (
                  <option key={t.v} value={t.v}>{t.label}</option>
                ))}
              </select>
            </div>
          </Row>

          <Row
            label="Re-encode as" htmlFor="opt-texfmt"
            hint={`Swaps the image format. JPEG${isGltf ? ' and WebP are' : ' is'} far smaller than PNG.`}
          >
            <div className="ctl">
              <select
                id="opt-texfmt" value={value.texture_format}
                onChange={(e) =>
                  set('texture_format', e.target.value as ConvertOptions['texture_format'])}
              >
                <option value="auto">Keep format</option>
                <option value="jpeg">JPEG</option>
                {isGltf && <option value="webp">WebP</option>}
              </select>
            </div>
          </Row>

          {value.texture_format !== 'auto' && (
            <Row
              label={`Quality ${value.texture_quality}`} htmlFor="opt-texq"
              hint="Higher keeps more detail and more bytes. 80 is usually indistinguishable."
            >
              <div className="ctl">
                <input
                  id="opt-texq" type="range" min={20} max={100} step={5}
                  value={value.texture_quality}
                  onChange={(e) => set('texture_quality', Number(e.target.value))}
                />
              </div>
            </Row>
          )}

          {value.texture_format !== 'auto' && (
            <div className="note">
              Images feeding transparency or a normal map keep the format they were
              authored in: JPEG has no alpha channel, and its blocking turns a normal
              map's gradients into faceted shading. The resolution cap still applies to
              them.
              {value.texture_format === 'webp'
                && ' WebP is carried by the EXT_texture_webp extension, which needs a'
                  + ' viewer that supports it.'}
            </div>
          )}

          {/* ---------------- output ---------------- */}
          <div className="group-label">Output</div>

          <Row
            label="Apply modifiers"
            hint="Bakes Simplify, the budget, welding and triangulation into the file. Turning this off discards all of them."
          >
            <Toggle on={value.apply_modifiers} onToggle={(v) => set('apply_modifiers', v)} />
          </Row>

          {droppedByModifiers && (
            <div className="warn-box">
              {reductions.join(', ')} {reductions.length > 1 ? 'are' : 'is'} set, but
              “Apply modifiers” is off — so {reductions.length > 1 ? 'they' : 'it'} will
              not reach the converted file. Turn it on to keep the reduction.
            </div>
          )}

          <Row
            label="Keep animations"
            hint="Writes animation data into the file, where the format can carry it."
          >
            <Toggle on={value.animations} onToggle={(v) => set('animations', v)} />
          </Row>

          {targetExt === '.glb' && (
            <Row
              label="Draco compression"
              hint="Shrinks mesh geometry, often 5–10× on vertex data. Needs a viewer that decodes it."
            >
              <Toggle on={value.draco} onToggle={(v) => set('draco', v)} />
            </Row>
          )}

          {targetExt === '.glb' && value.draco && (
            <Row
              label={`Draco level ${value.draco_level}`} htmlFor="opt-draco"
              hint="Higher is smaller and slower to encode. 6 is a good default."
            >
              <div className="ctl">
                <input
                  id="opt-draco" type="range" min={0} max={10} step={1}
                  value={value.draco_level}
                  onChange={(e) => set('draco_level', Number(e.target.value))}
                />
              </div>
            </Row>
          )}

          {isUsd && (
            <Row
              label="Y-up (ARKit)"
              hint="The orientation iOS Quick Look expects. Off leaves Blender's Z-up."
            >
              <Toggle on={value.y_up} onToggle={(v) => set('y_up', v)} />
            </Row>
          )}

          {isCadInput && (
            <Row
              label="CAD tessellation" htmlFor="opt-tol"
              hint="How finely the CAD surfaces are turned into triangles. Lower is finer, at more triangles and a slower conversion."
            >
              <div className="ctl">
                <input
                  id="opt-tol" type="number" min={0.0001} max={10} step={0.005}
                  value={value.cad_tolerance}
                  onChange={(e) => set('cad_tolerance', Math.max(0.0001, Number(e.target.value) || 0.01))}
                />
              </div>
            </Row>
          )}
        </>
      )}
    </div>
  )
}
