import { Fragment, useSyncExternalStore } from 'react'
import type { Clip, Pose } from '../api'
import { agreed, poseAt, REST, resetAt, seconds, track } from '../animation'
import type { Player } from '../player'

/**
 * Where the marked parts currently sit, spelled out.
 *
 * The sliders in the side panels say the same numbers, but they are not on
 * screen while the viewer fills the window -- and they are nowhere near the
 * gizmo you are dragging even when they are. So the figures are put over the
 * model as well: drag a handle and watch the number it is changing.
 *
 * Every figure is also the button that undoes it. A value away from rest is
 * live and clickable; one already at rest is inert, which is what tells you at
 * a glance that nothing on that axis has been touched.
 */

const AXES = ['X', 'Y', 'Z'] as const

const ROWS: { key: keyof Pose; label: string }[] = [
  { key: 'move', label: 'Position' },
  { key: 'rotate', label: 'Rotation' },
  { key: 'scale', label: 'Scale' },
]

/**
 * How each channel of a pose reads, given the size of the model it belongs to.
 *
 * A move is in the model's own units, so the useful number of decimals depends
 * on what those units turned out to be: three on a CAD bracket a few hundredths
 * across, none on an architectural export measured in tens of metres. Shared
 * with the sliders so the two never disagree about the same value.
 */
export function poseFormat(extent: number): Record<keyof Pose, (v: number) => string> {
  const decimals = extent < 1 ? 3 : extent < 100 ? 2 : 0
  return {
    move: (v) => v.toFixed(decimals),
    rotate: (v) => `${Math.round(v)}°`,
    scale: (v) => `${v.toFixed(2)}×`,
  }
}

export default function TransformReadout({ title, at, poses, extent, onReset }: {
  /** What is being read out: a part's name, "3 parts", "Whole model". */
  title: string
  /** The moment the pose is read at. Only set while a clip is open. */
  at?: string
  /** One pose per marked target. An empty list draws nothing. */
  poses: Pose[]
  /** The model's largest dimension, which decides how finely a move reads. */
  extent: number
  /** Put one axis -- or, with a null axis, a whole channel -- back to rest. */
  onReset: (key: keyof Pose, axis: number | null) => void
}) {
  if (!poses.length) return null
  const format = poseFormat(extent)

  return (
    <div className="xform">
      <div className="xform-head">
        <span className="xform-who" title={title}>{title}</span>
        {at && <span className="xform-at">{at}</span>}
      </div>

      <div className="xform-grid">
        <span />
        {AXES.map((axis) => <span key={axis} className="xform-axis">{axis}</span>)}

        {ROWS.map(({ key, label }) => {
          const values = [0, 1, 2].map((i) => agreed(poses, key, i))
          // A mixed axis counts as changed: putting the group back to rest is
          // exactly what you want when the parts no longer agree.
          const off = values.map((v, i) => v === null || v !== REST[key][i])
          return (
            <Fragment key={key}>
              <span className="xform-key">
                {label}
                {off.some(Boolean) && (
                  <button
                    className="xform-undo"
                    title={`Put ${label.toLowerCase()} back on all three axes`}
                    aria-label={`Reset ${label}`}
                    onClick={() => onReset(key, null)}
                  >
                    ↺
                  </button>
                )}
              </span>
              {values.map((v, i) => (
                <button
                  key={AXES[i]}
                  className={`xform-v${off[i] ? ' on' : ''}`}
                  disabled={!off[i]}
                  title={off[i]
                    ? `Put ${label.toLowerCase()} ${AXES[i]} back to ${format[key](REST[key][i])}`
                    : `${label} ${AXES[i]} is where it started`}
                  onClick={() => onReset(key, i)}
                >
                  {v === null ? '—' : format[key](v)}
                </button>
              ))}
            </Fragment>
          )
        })}
      </div>
    </div>
  )
}

/**
 * The same readout, but of a clip's pose at the playhead rather than of an edit.
 *
 * With a clip open the gizmo writes keyframes, so those are the numbers that
 * change as you drag and those are the ones worth showing. Resetting an axis
 * keys it back to rest at this moment rather than dropping the keyframe: the
 * pose either side of it is someone's work, and "back to nothing here" is a
 * pose like any other.
 *
 * Subscribes to the clock itself, the way the animation panel does, so the
 * figures follow playback without re-rendering the page around them.
 */
export function ClipReadout({ clip, targets, title, extent, player, onClip }: {
  clip: Clip
  /** Part names, or `[WHOLE]` for the model as one. */
  targets: readonly string[]
  title: string
  extent: number
  player: Player
  onClip: (next: Clip) => void
}) {
  useSyncExternalStore(player.subscribe, player.snapshot)
  const time = player.time
  const poses = targets.map((t) => poseAt(track(clip, t), time))

  const reset = (key: keyof Pose, axis: number | null) => {
    // A pose set by hand is a pose to look at, not one to play past.
    player.pause()
    onClip(resetAt(clip, targets, time, key, axis))
  }

  return (
    <TransformReadout
      title={title} at={seconds(time)} poses={poses} extent={extent} onReset={reset}
    />
  )
}
