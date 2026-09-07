import { useSyncExternalStore } from 'react'
import { WHOLE, type Clip, type Pose } from '../api'
import {
  agreed, isPosed, keyAt, poseAt, removeKey, resetAt, REST, seconds, setKey, track,
} from '../animation'
import type { Player } from '../player'
import { TransformSliders } from './PartEditor'

/**
 * Pose the marked parts -- or the whole model -- at the playhead.
 *
 * The sliders show where the targets are at this moment of the clip, keyed or
 * blended, and moving one writes a keyframe there: auto-keying, the way every
 * animation tool works once its record button is on. There is no separate
 * record button because there is nothing else the sliders could mean here.
 *
 * Subscribes to the clock itself, so the sliders follow playback without the
 * rest of the page re-rendering on every frame.
 */
export default function AnimEditor({ clip, targets, label, extent, player, onClip }: {
  clip: Clip
  /** Part names, or `[WHOLE]` for the model as one. Empty when nothing is marked. */
  targets: readonly string[]
  label: (target: string) => string
  extent: number
  player: Player
  onClip: (next: Clip) => void
}) {
  useSyncExternalStore(player.subscribe, player.snapshot)
  const time = player.time

  const poses = targets.map((t) => poseAt(track(clip, t), time))
  const keyed = targets.some((t) => keyAt(clip, t, time))

  // What the targets have in common, with a neutral value on any axis they
  // disagree about -- the panel is showing the group, not any one part.
  const shared: Pose = poses.length === 1 ? poses[0] : {
    move: channel(poses, 'move'),
    rotate: channel(poses, 'rotate'),
    scale: channel(poses, 'scale'),
  }

  /** A slider moved: key that one axis, at this moment, on every target. */
  const onAxis = (key: keyof Pose, i: number, v: number) => {
    // A pose set by hand is a pose to look at, not one to play past.
    player.pause()
    let next = clip
    targets.forEach((t, j) => {
      const own = [...poses[j][key]] as [number, number, number]
      own[i] = v
      next = setKey(next, t, time, { ...poses[j], [key]: own })
    })
    onClip(next)
  }

  /**
   * An undo beside a slider: key that axis, or that whole channel, back to
   * rest at this moment. A keyframe rather than a deletion -- the poses either
   * side of it are someone's work, and "back to nothing here" is a pose like
   * any other.
   */
  const onReset = (key: keyof Pose, axis: number | null) => {
    player.pause()
    onClip(resetAt(clip, targets, time, key, axis))
  }

  /** Key the pose the targets are in right now, blended or not: a hold. */
  const addKey = () => {
    player.pause()
    let next = clip
    targets.forEach((t, j) => { next = setKey(next, t, time, poses[j]) })
    onClip(next)
  }

  const dropKey = () => {
    let next = clip
    for (const t of targets) next = removeKey(next, t, time)
    onClip(next)
  }

  if (!targets.length) {
    return (
      <div className="edit-panel">
        <div className="note" style={{ marginTop: 0 }}>
          Mark a part — in the viewer or the list — to pose it at the playhead,
          or switch to <b>Whole model</b> above to move the model as one.
        </div>
      </div>
    )
  }

  const who = targets.length === 1
    ? (targets[0] === WHOLE ? 'the whole model' : label(targets[0]) || 'unnamed part')
    : `${targets.length} parts`

  return (
    <div className="edit-panel">
      <div className="edit-head">
        <span className="edit-name" title={targets.map(label).join(', ')}>
          Posing {who} at {seconds(time)}
        </span>
        {keyed && (
          <button className="edit-reset" title="Drop the keyframe at this moment" onClick={dropKey}>
            Remove key
          </button>
        )}
      </div>

      <TransformSliders
        scope="anim" value={shared} extent={extent} turns={2}
        onAxis={onAxis} onReset={onReset}
      />

      <div className="anim-acts">
        <button
          className="head-reset"
          title="Write the pose shown here as a keyframe at this moment"
          onClick={addKey}
        >
          {keyed ? 'Key again here' : 'Add keyframe here'}
        </button>
        <span className={`anim-status${keyed ? ' on' : ''}`}>
          {keyed
            ? '◆ keyframe at this moment'
            : isPosed(shared) || poses.some(isPosed) ? 'between keyframes' : 'at rest'}
        </span>
      </div>

      <div className="note">
        Moving a slider, or dragging a handle in the viewer, writes a keyframe at
        the playhead for every marked part. Scrub the timeline to another moment
        and pose again; the parts travel between the two. A keyframe is a change
        on top of the part's edited position, so the edits below the list still
        hold.
      </div>
    </div>
  )
}

/** One channel the targets share, resting on any axis they disagree about. */
const channel = (poses: Pose[], key: keyof Pose): [number, number, number] =>
  [0, 1, 2].map((i) => agreed(poses, key, i) ?? REST[key][i]) as [number, number, number]
