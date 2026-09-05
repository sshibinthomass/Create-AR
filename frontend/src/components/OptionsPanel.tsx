import { useState } from 'react'
import type { ConvertOptions } from '../api'

interface Props {
  value: ConvertOptions
  onChange: (next: ConvertOptions) => void
  targetExt: string
  isCadInput: boolean
}

function Toggle({ on, onToggle }: { on: boolean; onToggle: (v: boolean) => void }) {
  return (
    <label className="switch">
      <input type="checkbox" checked={on} onChange={(e) => onToggle(e.target.checked)} />
      <span />
    </label>
  )
}

export default function OptionsPanel({ value, onChange, targetExt, isCadInput }: Props) {
  const [open, setOpen] = useState(false)
  const set = <K extends keyof ConvertOptions>(key: K, v: ConvertOptions[K]) =>
    onChange({ ...value, [key]: v })

  const isUsd = ['.usdz', '.usdc', '.usda', '.usd'].includes(targetExt)

  return (
    <div className="opts">
      <button className="disclosure" onClick={() => setOpen(!open)}>
        <span>Conversion options</span>
        <span>{open ? '−' : '+'}</span>
      </button>

      {open && (
        <>
          <div className="opt-row">
            <label htmlFor="opt-scale">Scale</label>
            <div className="ctl">
              <input
                id="opt-scale" type="number" min={0.0001} max={10000} step={0.1}
                value={value.scale}
                onChange={(e) => set('scale', Math.max(0.0001, Number(e.target.value) || 1))}
              />
            </div>
          </div>

          <div className="opt-row">
            <label htmlFor="opt-center">Recentre</label>
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
          </div>

          <div className="opt-row">
            <label htmlFor="opt-dec">Simplify to {Math.round(value.decimate * 100)}%</label>
            <div className="ctl">
              <input
                id="opt-dec" type="range" min={0.05} max={1} step={0.05}
                value={value.decimate}
                onChange={(e) => set('decimate', Number(e.target.value))}
              />
            </div>
          </div>

          <div className="opt-row">
            <label>Triangulate faces</label>
            <Toggle on={value.triangulate} onToggle={(v) => set('triangulate', v)} />
          </div>

          <div className="opt-row">
            <label>Apply modifiers</label>
            <Toggle on={value.apply_modifiers} onToggle={(v) => set('apply_modifiers', v)} />
          </div>

          <div className="opt-row">
            <label>Keep animations</label>
            <Toggle on={value.animations} onToggle={(v) => set('animations', v)} />
          </div>

          {targetExt === '.glb' && (
            <div className="opt-row">
              <label>Draco compression</label>
              <Toggle on={value.draco} onToggle={(v) => set('draco', v)} />
            </div>
          )}

          {isUsd && (
            <div className="opt-row">
              <label>Y-up (ARKit)</label>
              <Toggle on={value.y_up} onToggle={(v) => set('y_up', v)} />
            </div>
          )}

          {isCadInput && (
            <div className="opt-row">
              <label htmlFor="opt-tol">CAD tessellation</label>
              <div className="ctl">
                <input
                  id="opt-tol" type="number" min={0.0001} max={10} step={0.005}
                  value={value.cad_tolerance}
                  onChange={(e) => set('cad_tolerance', Math.max(0.0001, Number(e.target.value) || 0.01))}
                />
              </div>
            </div>
          )}

          {isCadInput && (
            <div className="note">
              Lower tessellation values give a finer mesh from the CAD surfaces, at the cost of
              more triangles and a slower conversion.
            </div>
          )}
        </>
      )}
    </div>
  )
}
