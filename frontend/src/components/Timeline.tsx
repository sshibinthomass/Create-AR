import { useRef, useState, useSyncExternalStore } from 'react'
import { WHOLE, type Clip } from '../api'
import { keyTimes, moveKey, pruneClips, removeKey, seconds } from '../animation'
import type { Player } from '../player'

/** Keys and the playhead land on twentieths of a second. */
const SNAP = 0.05
/** Tick spacings to choose from, so the ruler never crowds. */
const STEPS = [0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60]
const MIN_DURATION = 0.5
const MAX_DURATION = 600

const stroke = {
  fill: 'none', stroke: 'currentColor', strokeWidth: 1.8,
  strokeLinecap: 'round', strokeLinejoin: 'round',
} as const

/**
 * The clip laid out in time: a ruler, a lane per animated part with a diamond
 * at each keyframe, and a playhead to drag through it.
 *
 * Dragging anywhere in the lanes scrubs; dragging a diamond moves that key.
 * Click a lane's name to mark the part it belongs to, so the editor beside
 * the list is pointed at it. Subscribes to the clock itself, for the same
 * reason the animation editor does: the playhead moves sixty times a second
 * and nothing else on the page should have to.
 */
export default function Timeline({ clip, player, label, onClip, onPick }: {
  clip: Clip
  player: Player
  label: (target: string) => string
  onClip: (next: Clip) => void
  onPick: (target: string) => void
}) {
  useSyncExternalStore(player.subscribe, player.snapshot)
  const { time, playing } = player
  const { duration } = clip

  const lanes = useRef<HTMLDivElement>(null)
  // The clip as of the latest render, for handlers that fire mid-drag: a key
  // slid three times in one frame has to slide from where the last slide put it.
  const latest = useRef(clip)
  latest.current = clip

  const [picked, setPicked] = useState<{ target: string; time: number } | null>(null)
  const scrubbing = useRef(false)
  const drag = useRef<{ target: string; time: number } | null>(null)

  const at = (clientX: number): number => {
    const box = lanes.current?.getBoundingClientRect()
    if (!box || box.width <= 0) return 0
    const raw = ((clientX - box.left) / box.width) * duration
    return Math.max(0, Math.min(duration, Math.round(raw / SNAP) * SNAP))
  }

  /* --- scrubbing --- */

  const scrubStart = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    player.pause()
    player.seek(at(e.clientX))
    scrubbing.current = true
    setPicked(null)
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  const scrubMove = (e: React.PointerEvent) => {
    if (scrubbing.current) player.seek(at(e.clientX))
  }
  const scrubEnd = (e: React.PointerEvent) => {
    scrubbing.current = false
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId)
    }
  }

  /* --- keys --- */

  const keyStart = (e: React.PointerEvent, target: string, t: number) => {
    if (e.button !== 0) return
    e.stopPropagation()
    player.pause()
    player.seek(t)
    setPicked({ target, time: t })
    drag.current = { target, time: t }
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  const keyMove = (e: React.PointerEvent) => {
    const held = drag.current
    if (!held) return
    const to = at(e.clientX)
    if (to === held.time) return
    onClip(moveKey(latest.current, held.target, held.time, to))
    held.time = to
    setPicked({ target: held.target, time: to })
    player.seek(to)
  }
  const keyEnd = (e: React.PointerEvent) => {
    drag.current = null
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId)
    }
  }

  const dropPicked = () => {
    if (!picked) return
    onClip(removeKey(clip, picked.target, picked.time))
    setPicked(null)
  }

  const onKey = (e: React.KeyboardEvent) => {
    if ((e.key === 'Delete' || e.key === 'Backspace') && picked) {
      e.preventDefault()
      dropPicked()
    } else if (e.key === ' ') {
      e.preventDefault()
      player.toggle()
    }
  }

  /* --- stepping --- */

  const moments = keyTimes(clip)
  const before = [...moments].reverse().find((t) => t < time - 1e-6)
  const after = moments.find((t) => t > time + 1e-6)

  const setDuration = (d: number) => {
    const next = Math.max(MIN_DURATION, Math.min(MAX_DURATION, d))
    if (!Number.isFinite(next) || next === duration) return
    // Keys past the new end would never be reached, and would still pull the
    // motion towards them on the way there -- so they go.
    const trimmed = { ...clip, duration: next, tracks: clip.tracks.map((t) => ({
      ...t, keys: t.keys.filter((k) => k.time <= next),
    })) }
    onClip(pruneClips([trimmed], () => true)[0] ?? { ...trimmed, tracks: [] })
  }

  const step = STEPS.find((s) => duration / s <= 12) ?? STEPS[STEPS.length - 1]
  const ticks: number[] = []
  for (let t = 0; t <= duration + 1e-9; t += step) ticks.push(Math.round(t * 1000) / 1000)

  const pct = (t: number) => `${(t / duration) * 100}%`

  return (
    <div className="tl" tabIndex={0} onKeyDown={onKey} aria-label={`Timeline of ${clip.name}`}>
      <div className="tl-bar">
        <button
          className="tl-btn tl-play"
          title={playing ? 'Pause (space)' : 'Play (space)'}
          onClick={() => player.toggle()}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" {...stroke}>
            {playing
              ? <path d="M8 5v14M16 5v14" />
              : <path d="M7 4.5v15l12-7.5z" fill="currentColor" />}
          </svg>
        </button>
        <button
          className="tl-btn" title="Back to the start"
          onClick={() => { player.pause(); player.seek(0) }}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" {...stroke}>
            <path d="M6 5v14M18 5.5v13l-10-6.5z" />
          </svg>
        </button>
        <button
          className="tl-btn" title="Previous keyframe" disabled={before === undefined}
          onClick={() => { player.pause(); if (before !== undefined) player.seek(before) }}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" {...stroke}>
            <path d="M16 6l-6 6 6 6M8 6v12" />
          </svg>
        </button>
        <button
          className="tl-btn" title="Next keyframe" disabled={after === undefined}
          onClick={() => { player.pause(); if (after !== undefined) player.seek(after) }}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" {...stroke}>
            <path d="M8 6l6 6-6 6M16 6v12" />
          </svg>
        </button>

        <span className="tl-time">
          {seconds(time)} <i>/</i> {seconds(duration)}
        </span>

        <label className="tl-len">
          Length
          <input
            type="number" min={MIN_DURATION} max={MAX_DURATION} step={0.5}
            value={duration}
            aria-label="Length of the animation, in seconds"
            onChange={(e) => setDuration(Number(e.target.value))}
          />
          s
        </label>

        {picked && (
          <button className="tl-btn tl-drop" title="Delete the selected keyframe (Delete)" onClick={dropPicked}>
            Delete key
          </button>
        )}
      </div>

      <div className="tl-body">
        <div className="tl-names">
          <div className="tl-ruler-name" />
          {clip.tracks.map((t) => (
            <button
              key={t.target}
              className="tl-name"
              title={t.target === WHOLE ? 'Pose the whole model' : 'Mark this part'}
              onClick={() => onPick(t.target)}
            >
              {t.target === WHOLE ? 'Whole model' : label(t.target) || 'Unnamed part'}
            </button>
          ))}
          {!clip.tracks.length && <div className="tl-name tl-none">—</div>}
        </div>

        <div
          ref={lanes}
          className="tl-lanes"
          onPointerDown={scrubStart}
          onPointerMove={scrubMove}
          onPointerUp={scrubEnd}
          onPointerCancel={scrubEnd}
        >
          <div className="tl-ruler">
            {ticks.map((t) => (
              <span key={t} className="tl-tick" style={{ left: pct(t) }}>
                <i />{Number.isInteger(t) ? t : t.toFixed(t * 10 % 1 ? 2 : 1)}
              </span>
            ))}
          </div>

          {clip.tracks.map((t) => (
            <div key={t.target} className="tl-lane">
              {t.keys.map((k) => (
                <button
                  key={k.time}
                  className={`tl-key${picked && picked.target === t.target && picked.time === k.time ? ' on' : ''}`}
                  style={{ left: pct(k.time) }}
                  title={`Keyframe at ${seconds(k.time)} — drag to move`}
                  aria-label={`Keyframe at ${seconds(k.time)}`}
                  onPointerDown={(e) => keyStart(e, t.target, k.time)}
                  onPointerMove={keyMove}
                  onPointerUp={keyEnd}
                  onPointerCancel={keyEnd}
                />
              ))}
            </div>
          ))}
          {!clip.tracks.length && (
            <div className="tl-lane tl-empty">
              No keyframes yet. Mark a part, move it, and a key lands here.
            </div>
          )}

          <div className="tl-head" style={{ left: pct(time) }} />
        </div>
      </div>
    </div>
  )
}
