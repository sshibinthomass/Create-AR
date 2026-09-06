import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { WHOLE, type Clip, type Ease } from '../api'
import {
  clearTrack, keyAt, keyTimes, poseAt, removeKey, sameKey, seconds, setEase,
  setKey, shiftKeys, shiftRoom, track, type KeyRef,
} from '../animation'
import type { Player } from '../player'

/** Keys and the playhead land on twentieths of a second. */
const SNAP = 0.05
/** Snapping leaves float dust; the same rounding `shiftKeys` uses clears it,
 *  so a time computed here is the same number as the one written into a key. */
const round = (t: number): number => Math.round(t * 1000) / 1000
/** Tick spacings to choose from, so the ruler never crowds. */
const STEPS = [0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60]
const MIN_DURATION = 0.5
const MAX_DURATION = 600

/** How tall the dock may be dragged, and where it starts. */
const MIN_HEIGHT = 150
const MAX_HEIGHT = 620
const OPEN_HEIGHT = 250

const stroke = {
  fill: 'none', stroke: 'currentColor', strokeWidth: 1.8,
  strokeLinecap: 'round', strokeLinejoin: 'round',
} as const

/** The shape a key is drawn as, so its easing is readable without selecting it. */
const EASES: { ease: Ease; label: string; hint: string }[] = [
  { ease: 'smooth', label: 'Smooth', hint: 'Pull away and settle gently — how a hand moves a part' },
  { ease: 'linear', label: 'Linear', hint: 'Travel at a constant rate, as a machine would' },
  { ease: 'hold', label: 'Hold', hint: 'Sit still until the next key, then be elsewhere' },
]

/**
 * The clip laid out in time, docked under the model.
 *
 * A ruler, a lane per animated part with a mark at each keyframe, and a
 * playhead to drag through it -- the dope sheet of an assembly study, where
 * the work is deciding which part moves when, and in what order. Dragging in
 * the lanes scrubs; dragging a mark retimes that key, and retimes every other
 * selected key with it, which is how a whole step of a teardown slides later
 * without being rebuilt.
 *
 * Docked rather than placed beside the viewer so that it comes along when the
 * model fills the window, and resizable because a fifty-part teardown needs
 * more lanes on screen than a hinge does.
 *
 * Subscribes to the clock itself, for the same reason the animation editor
 * does: the playhead moves sixty times a second and nothing else on the page
 * should have to re-render with it.
 */
export default function Timeline({
  clip, clips, player, targets, parts, selected, subject, label,
  onClip, onPickClip, onAddClip, onPick, onSubject,
}: {
  clip: Clip
  /** Every clip on the model, so the one being edited can be swapped here too. */
  clips: readonly Clip[]
  player: Player
  /** What "Add key" writes to: the marked parts, or `[WHOLE]` for the model. */
  targets: readonly string[]
  /** Every part in the model, by its name in the file: what can be marked. */
  parts: readonly string[]
  /** The parts marked right now, so the dock can show and change the marking. */
  selected: readonly string[]
  /** Whether keys land on the marked parts or on the model as one. */
  subject: 'parts' | 'model'
  label: (target: string) => string
  onClip: (next: Clip) => void
  onPickClip: (id: string) => void
  onAddClip: () => void
  onPick: (target: string, additive: boolean) => void
  onSubject: (next: 'parts' | 'model') => void
}) {
  useSyncExternalStore(player.subscribe, player.snapshot)
  const { time, playing, looping } = player
  const { duration } = clip

  const lanes = useRef<HTMLDivElement>(null)
  // The clip as of the latest render, for handlers that fire mid-drag: a key
  // slid three times in one frame has to slide from where the last slide put it.
  const latest = useRef(clip)
  latest.current = clip

  const [picked, setPicked] = useState<KeyRef[]>([])
  const [height, setHeight] = useState(OPEN_HEIGHT)
  const [shut, setShut] = useState(false)
  const scrubbing = useRef(false)
  // Where the drag began and what it is carrying, so every move is measured
  // from the grab rather than accumulated -- which would drift on a fast drag.
  // `origin` is where the carried keys sat when they were grabbed: the room
  // left to slide into has to be measured from there too, or the limit moves
  // along with the keys and the drag can walk off the end of the clip.
  const drag = useRef<
    { from: number; origin: KeyRef[]; held: KeyRef[]; moved: number } | null
  >(null)
  const sizing = useRef<{ y: number; from: number } | null>(null)

  // A clip with fewer keys than the selection remembers -- undone, deleted,
  // reversed -- must not leave the key tools acting on keys that are gone.
  useEffect(() => {
    setPicked((was) => {
      const live = was.filter((r) => keyAt(clip, r.target, r.time) !== undefined)
      return live.length === was.length ? was : live
    })
  }, [clip])

  const at = (clientX: number): number => {
    const box = lanes.current?.getBoundingClientRect()
    if (!box || box.width <= 0) return 0
    const raw = ((clientX - box.left) / box.width) * duration
    return round(Math.max(0, Math.min(duration, Math.round(raw / SNAP) * SNAP)))
  }

  /* --- scrubbing --- */

  const scrubStart = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    player.pause()
    player.seek(at(e.clientX))
    scrubbing.current = true
    setPicked([])
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  /** Both gestures capture on the lanes, so one handler dispatches between them. */
  const laneMove = (e: React.PointerEvent) => {
    if (drag.current) keyMove(e)
    else if (scrubbing.current) player.seek(at(e.clientX))
  }
  const laneEnd = (e: React.PointerEvent) => {
    scrubbing.current = false
    drag.current = null
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId)
    }
  }

  /* --- keys --- */

  const isPicked = (target: string, t: number) =>
    picked.some((r) => sameKey(r, { target, time: t }))

  const keyStart = (e: React.PointerEvent, target: string, t: number) => {
    if (e.button !== 0) return
    e.stopPropagation()
    player.pause()
    player.seek(t)
    const one = { target, time: t }
    const adding = e.shiftKey || e.ctrlKey || e.metaKey
    // Grabbing a key that is already in the selection drags the whole
    // selection; grabbing any other one starts a fresh selection from it.
    const held = adding
      ? (isPicked(target, t) ? picked.filter((r) => !sameKey(r, one)) : [...picked, one])
      : (isPicked(target, t) ? picked : [one])
    setPicked(held)
    drag.current = { from: t, origin: held, held, moved: 0 }
    // Captured on the lanes, never on the key itself. A key is keyed by its
    // moment, so retiming it replaces the element -- and a capture held by an
    // element React has just unmounted is gone, which would strand the drag
    // after the very first step. The lanes outlive every key in them.
    lanes.current?.setPointerCapture(e.pointerId)
  }

  const keyMove = (e: React.PointerEvent) => {
    const grab = drag.current
    if (!grab || !grab.held.length) return
    const [lo, hi] = shiftRoom(grab.origin, duration)
    const want = Math.max(lo, Math.min(hi, at(e.clientX) - grab.from))
    const step = want - grab.moved
    if (Math.abs(step) < 1e-9) return
    onClip(shiftKeys(latest.current, grab.held, step))
    grab.held = grab.held.map((r) => ({ ...r, time: round(r.time + step) }))
    grab.moved = want
    setPicked(grab.held)
    player.seek(grab.from + want)
  }

  const dropPicked = () => {
    if (!picked.length) return
    onClip(picked.reduce((c, r) => removeKey(c, r.target, r.time), clip))
    setPicked([])
  }

  const easePicked = (ease: Ease) => {
    if (picked.length) onClip(setEase(clip, picked, ease))
  }

  /** Key whatever pose the targets hold at the playhead: a stop on the way. */
  const addKey = () => {
    if (!targets.length) return
    player.pause()
    onClip(targets.reduce(
      (c, t) => setKey(c, t, time, poseAt(track(c, t), time)),
      clip,
    ))
    setPicked(targets.map((t) => ({ target: t, time })))
  }

  const keyedHere = targets.length > 0
    && targets.every((t) => keyAt(clip, t, time) !== undefined)

  const removeHere = () => {
    onClip(targets.reduce((c, t) => removeKey(c, t, time), clip))
    setPicked([])
  }

  const onKey = (e: React.KeyboardEvent) => {
    // The length box and the clip picker live in this same panel; typing in
    // one of them must not be read as a transport shortcut.
    if (e.target instanceof HTMLElement && /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) return
    if ((e.key === 'Delete' || e.key === 'Backspace') && picked.length) {
      e.preventDefault()
      dropPicked()
    } else if (e.key === ' ') {
      e.preventDefault()
      player.toggle()
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault()
      player.pause()
      player.seek(time + (e.key === 'ArrowLeft' ? -SNAP : SNAP))
    } else if (e.key === 'k' && targets.length) {
      e.preventDefault()
      addKey()
    }
  }

  /* --- resizing the dock --- */

  const sizeStart = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    sizing.current = { y: e.clientY, from: height }
    setShut(false)
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  const sizeMove = (e: React.PointerEvent) => {
    const grip = sizing.current
    if (!grip) return
    // Dragging the grip upward makes the dock taller, so the delta is inverted.
    setHeight(Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, grip.from + (grip.y - e.clientY))))
  }
  const sizeEnd = (e: React.PointerEvent) => {
    sizing.current = null
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId)
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
    onClip({
      ...clip,
      duration: next,
      tracks: clip.tracks
        .map((t) => ({ ...t, keys: t.keys.filter((k) => k.time <= next) }))
        .filter((t) => t.keys.length > 0),
    })
  }

  const step = STEPS.find((s) => duration / s <= 12) ?? STEPS[STEPS.length - 1]
  const ticks: number[] = []
  for (let t = 0; t <= duration + 1e-9; t += step) ticks.push(Math.round(t * 1000) / 1000)

  const pct = (t: number) => `${(t / duration) * 100}%`
  const name = (target: string) =>
    (target === WHOLE ? 'Whole model' : label(target) || 'Unnamed part')
  /** Whether a track's target is what the sliders and handles are pointed at. */
  const marked = (target: string) =>
    (target === WHOLE ? subject === 'model' : selected.includes(target))

  return (
    <div
      className={`tl${shut ? ' tl-shut' : ''}`}
      style={shut ? undefined : { height }}
      tabIndex={0}
      onKeyDown={onKey}
      aria-label={`Timeline of ${clip.name}`}
    >
      <div
        className="tl-grip"
        title="Drag to resize the timeline"
        onPointerDown={sizeStart}
        onPointerMove={sizeMove}
        onPointerUp={sizeEnd}
        onPointerCancel={sizeEnd}
      />

      {/* Transport: where you are in the clip, and which clip that is. */}
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
        <button
          className={`tl-btn${looping ? ' on' : ''}`}
          title={looping ? 'Playing over and over — click to play once' : 'Play once — click to loop'}
          onClick={() => player.setLooping(!looping)}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" {...stroke}>
            <path d="M4 9a4 4 0 0 1 4-4h11M19 15a4 4 0 0 1-4 4H4" />
            <path d="M16 2.5 19.5 5 16 7.5M8 16.5 4.5 19 8 21.5" />
          </svg>
        </button>

        <span className="tl-time">
          {seconds(time)} <i>/</i> {seconds(duration)}
        </span>

        <div className="tl-gap" />

        <label className="tl-pick">
          Animation
          <select
            value={clip.id}
            aria-label="Which animation is being edited"
            onChange={(e) => onPickClip(e.target.value)}
          >
            {clips.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </label>
        <button
          className="tl-btn"
          title="Start another animation on this model"
          aria-label="Add an animation"
          onClick={onAddClip}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" {...stroke}>
            <path d="M12 5v14M5 12h14" />
          </svg>
        </button>

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

        <button
          className="tl-btn tl-shutter"
          title={shut ? 'Show the timeline' : 'Collapse the timeline'}
          onClick={() => setShut((was) => !was)}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" {...stroke}>
            <path d={shut ? 'M6 15l6-6 6 6' : 'M6 9l6 6 6-6'} />
          </svg>
        </button>
      </div>

      {!shut && (
        <>
          {/* Keyframe tools: what a key does, and what to do with the ones
              currently marked. Always present, so nothing shifts under the
              pointer as a selection comes and goes. */}
          <div className="tl-keybar">
            <button
              className="tl-act"
              disabled={!targets.length}
              title={targets.length
                ? 'Hold the marked parts where they are at the playhead (K)'
                : 'Mark a part in the viewer or the list first'}
              onClick={addKey}
            >
              <span className="tl-dot" /> Add key
            </button>
            <button
              className="tl-act"
              disabled={!keyedHere}
              title="Drop the marked parts' keys at the playhead"
              onClick={removeHere}
            >
              Remove key
            </button>

            <div className="tl-sep" />

            <div className="tl-eases" role="group" aria-label="What a keyframe moves">
              <button
                className={`tl-ease${subject === 'parts' ? ' sel' : ''}`}
                title="Keys move the parts you have marked"
                onClick={() => onSubject('parts')}
              >
                Marked parts
              </button>
              <button
                className={`tl-ease${subject === 'model' ? ' sel' : ''}`}
                title="Keys move the whole model as one piece"
                onClick={() => onSubject('model')}
              >
                Whole model
              </button>
            </div>

            {/* One marked part shows as the picked one; none or several have
                nothing single to show, so a summary stands in its place. */}
            <select
              className="tl-parts"
              value={subject === 'parts' && selected.length === 1 ? selected[0] : ''}
              aria-label="Mark a part to animate"
              title="Mark a part — shift-click a track name, or shift-click in the viewer, to mark several"
              onChange={(e) => { if (e.target.value) onPick(e.target.value, false) }}
            >
              {(subject === 'model' || selected.length !== 1) && (
                <option value="">
                  {subject === 'model'
                    ? 'Whole model'
                    : selected.length === 0 ? 'No part marked'
                      : `${selected.length} parts marked`}
                </option>
              )}
              {parts.map((n) => (
                <option key={n} value={n}>{label(n) || 'Unnamed part'}</option>
              ))}
            </select>

            <div className="tl-sep" />

            <span className="tl-ease-label">Motion out of key</span>
            <div className="tl-eases">
              {EASES.map((e) => (
                <button
                  key={e.ease}
                  className={`tl-ease${
                    picked.length && picked.every((r) => keyEase(clip, r) === e.ease) ? ' sel' : ''}`}
                  disabled={!picked.length}
                  title={e.hint}
                  onClick={() => easePicked(e.ease)}
                >
                  {e.label}
                </button>
              ))}
            </div>

            <div className="tl-gap" />

            <span className="tl-count">
              {picked.length
                ? `${picked.length} key${picked.length === 1 ? '' : 's'} marked`
                : 'no key marked'}
            </span>
            <button
              className="tl-act tl-drop"
              disabled={!picked.length}
              title="Delete the marked keyframes (Delete)"
              onClick={dropPicked}
            >
              Delete
            </button>
          </div>

          <div className="tl-body">
            <div className="tl-names">
              <div className="tl-ruler-name">Part</div>
              {clip.tracks.map((t) => (
                <div
                  key={t.target}
                  className={`tl-name-row${marked(t.target) ? ' on' : ''}`}
                >
                  <button
                    className="tl-name"
                    title={t.target === WHOLE
                      ? 'Pose the whole model'
                      : `Mark ${name(t.target)} — shift-click to mark it as well as the others`}
                    onClick={(e) => onPick(t.target, e.shiftKey || e.ctrlKey || e.metaKey)}
                  >
                    {name(t.target)}
                  </button>
                  <span className="tl-name-n">{t.keys.length}</span>
                  <button
                    className="tl-name-x"
                    title={`Take ${name(t.target)} out of this animation`}
                    onClick={() => { onClip(clearTrack(clip, t.target)); setPicked([]) }}
                  >
                    ✕
                  </button>
                </div>
              ))}
              {!clip.tracks.length && <div className="tl-name tl-none">—</div>}
            </div>

            <div
              ref={lanes}
              className="tl-lanes"
              onPointerDown={scrubStart}
              onPointerMove={laneMove}
              onPointerUp={laneEnd}
              onPointerCancel={laneEnd}
            >
              <div className="tl-ruler">
                {ticks.map((t) => (
                  <span key={t} className="tl-tick" style={{ left: pct(t) }}>
                    <i />{Number.isInteger(t) ? t : t.toFixed(t * 10 % 1 ? 2 : 1)}
                  </span>
                ))}
              </div>

              {clip.tracks.map((t) => {
                const first = t.keys[0]?.time ?? 0
                const last = t.keys[t.keys.length - 1]?.time ?? 0
                return (
                  <div key={t.target} className="tl-lane">
                    {/* The span a part is in motion over: at a glance, which
                        step of the teardown happens when. */}
                    {t.keys.length > 1 && (
                      <span
                        className="tl-span"
                        style={{ left: pct(first), width: pct(last - first) }}
                      />
                    )}
                    {t.keys.map((k) => (
                      <button
                        key={k.time}
                        className={`tl-key tl-${k.ease ?? 'linear'}${
                          isPicked(t.target, k.time) ? ' on' : ''}`}
                        style={{ left: pct(k.time) }}
                        title={`${name(t.target)} at ${seconds(k.time)} — drag to retime, shift-click to add to the selection`}
                        aria-label={`Keyframe on ${name(t.target)} at ${seconds(k.time)}`}
                        onPointerDown={(e) => keyStart(e, t.target, k.time)}
                      />
                    ))}
                  </div>
                )
              })}
              {!clip.tracks.length && (
                <div className="tl-lane tl-empty">
                  No keyframes yet. Mark a part, scrub to a moment, move it — and a key lands here.
                </div>
              )}

              <div className="tl-head" style={{ left: pct(time) }} />
            </div>
          </div>
        </>
      )}
    </div>
  )
}

/** The ease on one referenced key, for showing which button is the current one. */
const keyEase = (clip: Clip, ref: KeyRef): Ease =>
  keyAt(clip, ref.target, ref.time)?.ease ?? 'linear'
