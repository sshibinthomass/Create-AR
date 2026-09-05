import { MATERIALS, isEdited, type MaterialType, type PartEdit } from '../api'

const AXES = ['X', 'Y', 'Z'] as const

interface Props {
  /** Every part the change applies to, by the name shown in the list. */
  names: string[]
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
function Slider({ id, label, value, min, max, step, format, onChange }: {
  id: string
  label: string
  value: number
  min: number
  max: number
  step: number
  format: (v: number) => string
  onChange: (v: number) => void
}) {
  return (
    <div className="edit-row">
      <label htmlFor={id}>{label}</label>
      <input
        id={id} type="range" min={min} max={max} step={step} value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <span className="edit-v">{format(value)}</span>
    </div>
  )
}

/** Move, rotate, scale and restyle whichever parts are currently marked. */
export default function PartEditor({ names, value, extent, onChange, onReset }: Props) {
  const set = <K extends keyof PartEdit>(key: K, v: PartEdit[K]) =>
    onChange({ ...value, [key]: v })

  const setAxis = (key: 'move' | 'rotate' | 'scale', i: number, v: number) => {
    const next = [...value[key]] as [number, number, number]
    next[i] = v
    set(key, next)
  }

  // Nudging is bounded by the model's own size: a slider that ran to a fixed
  // number of units would be uselessly coarse on a CAD bracket and uselessly
  // fine on a building.
  const reach = extent
  const decimals = reach < 1 ? 3 : reach < 100 ? 2 : 0

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

      <div className="edit-group">Move</div>
      {AXES.map((axis, i) => (
        <Slider
          key={`m${axis}`} id={`edit-move-${axis}`} label={axis} value={value.move[i]}
          min={-reach} max={reach} step={reach / 200}
          format={(v) => v.toFixed(decimals)}
          onChange={(v) => setAxis('move', i, v)}
        />
      ))}

      <div className="edit-group">Rotate</div>
      {AXES.map((axis, i) => (
        <Slider
          key={`r${axis}`} id={`edit-rot-${axis}`} label={axis} value={value.rotate[i]}
          min={-180} max={180} step={1}
          format={(v) => `${v}°`}
          onChange={(v) => setAxis('rotate', i, v)}
        />
      ))}

      <div className="edit-group">Scale</div>
      {AXES.map((axis, i) => (
        <Slider
          key={`s${axis}`} id={`edit-scale-${axis}`} label={axis} value={value.scale[i]}
          min={0.05} max={4} step={0.01}
          format={(v) => `${v.toFixed(2)}×`}
          onChange={(v) => setAxis('scale', i, v)}
        />
      ))}

      <div className="edit-group">Material</div>
      <div className="edit-row">
        <label htmlFor="edit-material">Type</label>
        <select
          id="edit-material" value={value.material}
          onChange={(e) => set('material', e.target.value as MaterialType)}
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

      {value.material && (
        <div className="note">
          A new material replaces everything the part was shaded with, its
          textures included. Leave this on “Keep original” to move the part
          without touching how it looks.
        </div>
      )}
    </div>
  )
}
