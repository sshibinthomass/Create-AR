import { MATERIALS, isEdited, type MaterialType, type PartEdit, type Pose } from '../api'

const AXES = ['X', 'Y', 'Z'] as const

interface Props {
  /** Every part the change applies to, by the name shown in the list. */
  names: string[]
  /**
   * Distinguishes this panel's control ids from another's.
   *
   * Two editors can be on the page at once -- the one under the parts list and
   * the one in a part's own dialog -- and a duplicated id would point both
   * labels at whichever control the document happens to hold first.
   */
  scope?: string
  value: PartEdit
  /** The model's largest dimension, which sets how far a part can be nudged. */
  extent: number
  onChange: (next: PartEdit) => void
  onReset: () => void
}

/**
 * A slider with its value spelled out, for one component of one edit.
 *
 * Sliders rather than number boxes throughout: the useful gesture here is
 * nudging a part until it looks right in the viewer beside you, not entering a
 * figure you already know.
 */
function Slider({ id, label, value, min, max, step, format, onChange, disabled }: {
  id: string
  label: string
  value: number
  min: number
  max: number
  step: number
  format: (v: number) => string
  onChange: (v: number) => void
  disabled?: boolean
}) {
  return (
    <div className={`edit-row${disabled ? ' off' : ''}`}>
      <label htmlFor={id}>{label}</label>
      <input
        id={id} type="range" min={min} max={max} step={step} value={value}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <span className="edit-v">{format(value)}</span>
    </div>
  )
}

/**
 * The move, rotate and scale sliders, for a pose held still or a pose at a
 * moment: the edit panel and the animation panel both put a part where it
 * should be with these, and differ only in what they do with the answer.
 *
 * Nudging is bounded by the model's own size: a slider that ran to a fixed
 * number of units would be uselessly coarse on a CAD bracket and uselessly
 * fine on a building. `turns` widens the rotate sliders, for keyframes -- a
 * spin needs to be able to say 360°, which an edit never does.
 */
export function TransformSliders({ scope, value, extent, turns = 0.5, onAxis }: {
  scope: string
  value: Pose
  extent: number
  turns?: number
  onAxis: (key: keyof Pose, axis: number, v: number) => void
}) {
  const reach = extent
  const decimals = reach < 1 ? 3 : reach < 100 ? 2 : 0
  const spin = 360 * turns

  return (
    <>
      <div className="edit-group">Move</div>
      {AXES.map((axis, i) => (
        <Slider
          key={`m${axis}`} id={`${scope}-move-${axis}`} label={axis} value={value.move[i]}
          min={-reach} max={reach} step={reach / 200}
          format={(v) => v.toFixed(decimals)}
          onChange={(v) => onAxis('move', i, v)}
        />
      ))}

      <div className="edit-group">Rotate</div>
      {AXES.map((axis, i) => (
        <Slider
          key={`r${axis}`} id={`${scope}-rot-${axis}`} label={axis} value={value.rotate[i]}
          min={-spin} max={spin} step={1}
          format={(v) => `${Math.round(v)}°`}
          onChange={(v) => onAxis('rotate', i, v)}
        />
      ))}

      <div className="edit-group">Scale</div>
      {AXES.map((axis, i) => (
        <Slider
          key={`s${axis}`} id={`${scope}-scale-${axis}`} label={axis} value={value.scale[i]}
          min={0.05} max={4} step={0.01}
          format={(v) => `${v.toFixed(2)}×`}
          onChange={(v) => onAxis('scale', i, v)}
        />
      ))}
    </>
  )
}

/** Move, rotate, scale and restyle whichever parts are currently marked. */
export default function PartEditor({
  names, scope = 'edit', value, extent, onChange, onReset,
}: Props) {
  const set = <K extends keyof PartEdit>(key: K, v: PartEdit[K]) =>
    onChange({ ...value, [key]: v })

  /**
   * Choose a preset, and start its finish sliders where the preset puts them.
   *
   * They are overrides on the preset, so they have to begin at what they are
   * overriding -- otherwise picking "metal" would silently drag the roughness
   * off to whatever the last preset happened to leave behind.
   */
  const setMaterial = (kind: MaterialType) => {
    const preset = MATERIALS[kind as keyof typeof MATERIALS]
    onChange(preset
      ? { ...value, material: kind, roughness: preset.roughness, metalness: preset.metalness }
      : { ...value, material: kind })
  }

  const setAxis = (key: keyof Pose, i: number, v: number) => {
    const next = [...value[key]] as [number, number, number]
    next[i] = v
    set(key, next)
  }

  return (
    <div className="edit-panel">
      <div className="edit-head">
        <span className="edit-name" title={names.join(', ')}>
          {names.length === 1
            ? `Editing ${names[0] || 'unnamed part'}`
            : `Editing ${names.length} parts`}
        </span>
        {isEdited(value) && (
          <button className="edit-reset" onClick={onReset}>Reset</button>
        )}
      </div>

      {names.length > 1 && (
        <div className="note">
          Every marked part takes the change together, turning and growing about
          the middle of the group. A value the parts do not already agree on
          shows as none until you set it.
        </div>
      )}

      <TransformSliders scope={scope} value={value} extent={extent} onAxis={setAxis} />

      <div className="edit-group">Material</div>
      <div className="edit-row">
        <label htmlFor={`${scope}-material`}>Type</label>
        <select
          id={`${scope}-material`} value={value.material}
          onChange={(e) => setMaterial(e.target.value as MaterialType)}
        >
          <option value="">Keep original</option>
          {Object.entries(MATERIALS).map(([key, m]) => (
            <option key={key} value={key}>{m.label}</option>
          ))}
        </select>
        <input
          type="color" value={value.color} disabled={!value.material}
          aria-label="Part colour"
          onChange={(e) => set('color', e.target.value)}
        />
      </div>

      {/* Opacity needs no preset: fading a housing to see inside it is worth
          doing without throwing away the finish you are looking through. */}
      <Slider
        id={`${scope}-opacity`} label="Opaque" value={value.opacity}
        min={0.05} max={1} step={0.01}
        format={(v) => `${Math.round(v * 100)}%`}
        onChange={(v) => set('opacity', v)}
      />
      <Slider
        id={`${scope}-rough`} label="Rough" value={value.roughness}
        min={0} max={1} step={0.01} disabled={!value.material}
        format={(v) => v.toFixed(2)}
        onChange={(v) => set('roughness', v)}
      />
      <Slider
        id={`${scope}-metal`} label="Metal" value={value.metalness}
        min={0} max={1} step={0.01} disabled={!value.material}
        format={(v) => v.toFixed(2)}
        onChange={(v) => set('metalness', v)}
      />

      <div className="note">
        {value.material
          ? `A new material replaces everything the part was shaded with, its
             textures included. Rough and metal start where the preset puts them
             and are yours to nudge.`
          : `Opacity works on the part as it is. Rough and metal need a material
             to apply to — there is no telling what the file shaded this part
             with, so there is no value that would mean “leave it alone”.`}
      </div>
    </div>
  )
}
