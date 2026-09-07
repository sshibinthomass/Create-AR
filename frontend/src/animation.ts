/**
 * Keyframe animation for the Analysis tab, and the arithmetic behind it.
 *
 * A clip is a name, a length and a set of tracks; a track is every keyframe
 * one target has in that clip; a keyframe is a pose at a moment. A pose is the
 * same three deltas an edit carries -- move, rotate, scale -- laid on top of
 * the part's edited pose, so a part can be nudged into place *and* animated
 * from there.
 *
 * The viewer plays a clip by asking `poseAt` for each track on every frame.
 * The backend bakes the same function frame by frame into the file, so the two
 * have to agree exactly: `sample_pose` in blender_job.py mirrors `poseAt` here.
 */
import { Euler, Quaternion, Vector3, type Object3D } from 'three'
import type { Clip, Ease, Keyframe, Pose, Track } from './api'

export const REST: Pose = { move: [0, 0, 0], rotate: [0, 0, 0], scale: [1, 1, 1] }

/** How long a clip runs unless the user says otherwise. */
export const DEFAULT_DURATION = 3

/** Two keys nearer than this are the same moment. */
const EPS = 1e-6

const DEG = Math.PI / 180

const lerp3 = (a: readonly number[], b: readonly number[], k: number): [number, number, number] =>
  [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k]

const pose = (k: Keyframe): Pose => ({ move: k.move, rotate: k.rotate, scale: k.scale })

/** What new keyframes get, because a part that starts and stops dead looks wrong. */
export const DEFAULT_EASE: Ease = 'smooth'

/**
 * The fraction travelled, given the fraction of the way through in time.
 *
 * `smooth` is a smoothstep: away from a key and into the next one gently,
 * which is how a part actually comes off an assembly. `hold` does not travel
 * at all -- the part sits at this key until the next one takes over, which is
 * how you make a step rather than a slide.
 *
 * Mirrored by `_shape` in blender_job.py, which bakes these into the file.
 */
export function shape(k: number, ease: Ease | undefined): number {
  if (ease === 'hold') return 0
  if (ease === 'smooth') return k * k * (3 - 2 * k)
  return k
}

/**
 * The pose a track is in `time` seconds in: held before the first key and
 * after the last, blended between neighbours along the earlier key's ease.
 *
 * Rotation is blended in degrees rather than as a quaternion. That is what
 * lets a key at 360° mean a full turn -- a quaternion would call it the same
 * as 0° and the part would sit still.
 */
export function poseAt(track: Track | undefined, time: number): Pose {
  const keys = track?.keys
  if (!keys?.length) return REST
  if (time <= keys[0].time) return pose(keys[0])
  const last = keys[keys.length - 1]
  if (time >= last.time) return pose(last)
  let i = 1
  while (keys[i].time < time) i++
  const a = keys[i - 1]
  const b = keys[i]
  const span = b.time - a.time
  const k = shape(span <= 0 ? 0 : (time - a.time) / span, a.ease)
  return { move: lerp3(a.move, b.move, k), rotate: lerp3(a.rotate, b.rotate, k), scale: lerp3(a.scale, b.scale, k) }
}

export const isPosed = (p: Pose): boolean =>
  p.move.some((v) => v !== 0) || p.rotate.some((v) => v !== 0) || p.scale.some((v) => v !== 1)

/** Whether one axis of one channel is still where it started. */
export const atRest = (p: Pose, key: keyof Pose, axis: number): boolean =>
  p[key][axis] === REST[key][axis]

/**
 * One channel of a pose with a single axis -- or, with `axis` null, all three
 * -- put back to rest.
 *
 * The panels and the readout both undo a change this way, and both hand the
 * result back as a whole channel, because that is the shape a pose stores.
 */
export const restAxes = (
  p: Pose, key: keyof Pose, axis: number | null,
): [number, number, number] =>
  p[key].map((v, i) => (axis === null || axis === i ? REST[key][i] : v)) as
    [number, number, number]

export const track = (clip: Clip, target: string): Track | undefined =>
  clip.tracks.find((t) => t.target === target)

export const keyAt = (clip: Clip, target: string, time: number): Keyframe | undefined =>
  track(clip, target)?.keys.find((k) => Math.abs(k.time - time) < EPS)

let counter = 0

export function newClip(name: string, duration = DEFAULT_DURATION): Clip {
  counter += 1
  return { id: `${Date.now().toString(36)}-${counter}`, name, duration, tracks: [] }
}

/**
 * The clip with one key written: replacing the key at that moment, if there is one.
 *
 * Overwriting keeps the ease already on that moment, so nudging a slider on a
 * key you had made a `hold` does not quietly turn it back into a slide.
 */
export function setKey(clip: Clip, target: string, time: number, p: Pose, ease?: Ease): Clip {
  const was = keyAt(clip, target, time)
  const key: Keyframe = {
    time, move: p.move, rotate: p.rotate, scale: p.scale,
    ease: ease ?? was?.ease ?? DEFAULT_EASE,
  }
  const existing = track(clip, target)
  const keys = (existing?.keys ?? []).filter((k) => Math.abs(k.time - time) >= EPS)
  keys.push(key)
  keys.sort((a, b) => a.time - b.time)
  const next: Track = { target, keys }
  return {
    ...clip,
    tracks: existing
      ? clip.tracks.map((t) => (t.target === target ? next : t))
      : [...clip.tracks, next],
  }
}

/** The clip without the key at that moment. A track with no keys left goes too. */
export function removeKey(clip: Clip, target: string, time: number): Clip {
  return {
    ...clip,
    tracks: clip.tracks
      .map((t) => (t.target === target
        ? { ...t, keys: t.keys.filter((k) => Math.abs(k.time - time) >= EPS) }
        : t))
      .filter((t) => t.keys.length > 0),
  }
}

/** Slide one key to another moment, taking the place of whatever was there. */
export function moveKey(clip: Clip, target: string, from: number, to: number): Clip {
  const key = keyAt(clip, target, from)
  if (!key || Math.abs(from - to) < EPS) return clip
  return setKey(removeKey(clip, target, from), target, to, key)
}

/** Times are twentieths of a second; carrying float dust past that helps nobody. */
const round = (t: number): number => Math.round(t * 1000) / 1000

/** One keyframe, named by the track it is on and the moment it sits at. */
export interface KeyRef {
  target: string
  time: number
}

export const sameKey = (a: KeyRef, b: KeyRef): boolean =>
  a.target === b.target && Math.abs(a.time - b.time) < EPS

/**
 * Slide a set of keys along the clip together, keeping their spacing.
 *
 * Taking them all out before putting any back is what lets a selection slide
 * *over* keys it is passing -- the moved key takes that moment, and lifting
 * first means a key still being carried is never the one displaced.
 */
export function shiftKeys(clip: Clip, refs: readonly KeyRef[], delta: number): Clip {
  if (!refs.length || Math.abs(delta) < EPS) return clip
  const held = refs
    .map((r) => ({ target: r.target, key: keyAt(clip, r.target, r.time) }))
    .filter((h): h is { target: string; key: Keyframe } => h.key !== undefined)
  let next = refs.reduce((c, r) => removeKey(c, r.target, r.time), clip)
  for (const { target, key } of held) {
    next = setKey(next, target, round(key.time + delta), key, key.ease)
  }
  return next
}

/** How far a selection may slide before the outermost key leaves the clip. */
export function shiftRoom(refs: readonly KeyRef[], duration: number): [number, number] {
  if (!refs.length) return [0, 0]
  const times = refs.map((r) => r.time)
  return [-Math.min(...times), duration - Math.max(...times)]
}

/** The clip with a set of keys given a different ease. */
export function setEase(clip: Clip, refs: readonly KeyRef[], ease: Ease): Clip {
  const on = (t: string, time: number) => refs.some((r) => sameKey(r, { target: t, time }))
  return {
    ...clip,
    tracks: clip.tracks.map((t) => (refs.some((r) => r.target === t.target)
      ? { ...t, keys: t.keys.map((k) => (on(t.target, k.time) ? { ...k, ease } : k)) }
      : t)),
  }
}

/**
 * The clip played backwards: every key mirrored about the clip's length.
 *
 * A disassembly run in reverse is the assembly, which is the whole reason this
 * is here -- take the model apart once, and the putting-together comes free.
 * The ease moves back one key with the direction: the shape that governed
 * leaving a key now governs leaving the key that used to follow it, which for
 * `linear` and `smooth` reproduces the original motion exactly backwards.
 *
 * `hold` cannot be mirrored exactly, and is not meant to be. A step's mirror
 * is a step at the far end of the same span, which no single key can say. What
 * comes out instead is the reading that matches what a hold is *for*: a cover
 * that sits in place and then pops off, reversed, sits off and pops back on at
 * the mirrored moment -- the span it waits over is the same, and it waits in
 * the pose it is travelling from either way.
 */
export function reverseClip(clip: Clip): Clip {
  return {
    ...clip,
    tracks: clip.tracks.map((t) => {
      const flipped = t.keys.map((k) => ({ ...k, time: round(clip.duration - k.time) }))
        .sort((a, b) => a.time - b.time)
      const eases = t.keys.map((k) => k.ease)
      // Key i now leaves towards what was its predecessor, so it takes that
      // segment's shape; the new last key keeps whatever the old first had.
      return {
        ...t,
        keys: flipped.map((k, i) => ({
          ...k, ease: eases[eases.length - 1 - i - 1] ?? eases[0] ?? DEFAULT_EASE,
        })),
      }
    }),
  }
}

/**
 * Several clips played as one: all at once, or one after another.
 *
 * This is how an answer gets shown. A question like "how do I raise the seat?"
 * is answered by a handful of clips -- find the lever, turn it, lift the seat --
 * and what the person asking wants is one thing to press play on, not three.
 * `sequence` lays them end to end for a set of steps; `together` overlays them
 * for motions that happen at the same time.
 *
 * A part keeps whatever pose the clip before it left it in, because `poseAt`
 * holds a track after its last key. That is what a sequence of steps means: a
 * cover taken off in step one is still off in step three.
 *
 * Where two clips key the same part at the same instant, the earlier one in the
 * list wins -- the opposite of `setKey`'s own rule, and deliberately. In a
 * sequence the contested instant is always the boundary between two steps: the
 * pose the first step arrives at, and the rest pose the second sets out from.
 * Letting the second win would cancel the first step outright, so that a clip
 * that raised a seat travels towards a key that has been replaced by rest and
 * never moves at all.
 */
export function mergeClips(
  clips: readonly Clip[], name: string, mode: 'sequence' | 'together' = 'sequence',
): Clip {
  let out = newClip(name, DEFAULT_DURATION)
  let offset = 0
  const pivots = new Map<string, [number, number, number]>()
  for (const c of clips) {
    for (const t of c.tracks) {
      if (t.pivot) pivots.set(t.target, t.pivot)
      for (const k of t.keys) {
        const when = round(offset + k.time)
        if (keyAt(out, t.target, when)) continue
        out = setKey(out, t.target, when, pose(k), k.ease)
      }
    }
    if (mode === 'sequence') offset += c.duration
  }
  const duration = mode === 'sequence'
    ? offset
    : clips.reduce((longest, c) => Math.max(longest, c.duration), 0)
  return {
    ...out,
    // Merging nothing still has to give back a playable clip: a length of zero
    // is not a clip, and the exporter refuses one.
    duration: duration || DEFAULT_DURATION,
    tracks: out.tracks.map((t) => (pivots.has(t.target)
      ? { ...t, pivot: pivots.get(t.target) } : t)),
    meta: {
      kind: 'merged',
      targets: [...new Set(clips.flatMap((c) => c.meta?.targets ?? []))],
      labels: [...new Set(clips.flatMap((c) => c.meta?.labels ?? []))],
      axis: '',
      amount: clips.length,
      summary: clips.map((c) => c.meta?.summary ?? c.name).join(' '),
      tags: [...new Set(clips.flatMap((c) => c.meta?.tags ?? []))],
    },
  }
}

/** A copy of a clip, under a new name and with an id of its own. */
export function copyClip(clip: Clip, name: string): Clip {
  counter += 1
  return {
    ...clip,
    id: `${Date.now().toString(36)}-${counter}`,
    name,
    tracks: clip.tracks.map((t) => ({ ...t, keys: t.keys.map((k) => ({ ...k })) })),
  }
}

/** The clip with one target's keys all gone. */
export const clearTrack = (clip: Clip, target: string): Clip =>
  ({ ...clip, tracks: clip.tracks.filter((t) => t.target !== target) })

/** Every moment anything in the clip is keyed at, in order and once each. */
export function keyTimes(clip: Clip): number[] {
  const times = new Set<number>()
  for (const t of clip.tracks) for (const k of t.keys) times.add(k.time)
  return [...times].sort((a, b) => a - b)
}

/** Keys on parts that are no longer there are dropped, and a clip left empty with them. */
export function pruneClips(clips: Clip[], keep: (target: string) => boolean): Clip[] {
  return clips
    .map((c) => ({ ...c, tracks: c.tracks.filter((t) => t.keys.length && keep(t.target)) }))
    .filter((c) => c.tracks.length > 0)
}

/* ---------- composing poses ---------- */

const quat = (rotate: readonly number[]): Quaternion =>
  new Quaternion().setFromEuler(new Euler(rotate[0] * DEG, rotate[1] * DEG, rotate[2] * DEG, 'XYZ'))

const degrees = (q: Quaternion): [number, number, number] => {
  const e = new Euler().setFromQuaternion(q, 'XYZ')
  return [e.x / DEG, e.y / DEG, e.z / DEG]
}

/**
 * Lay an animated pose over a node already sitting in its edited pose.
 *
 * Move adds in the parent's space, rotation multiplies on the right and scale
 * multiplies componentwise -- the same way an edit goes onto the rest pose, and
 * the composition the exporter bakes.
 */
export function applyPose(node: Object3D, p: Pose): void {
  node.position.x += p.move[0]
  node.position.y += p.move[1]
  node.position.z += p.move[2]
  node.quaternion.multiply(quat(p.rotate))
  node.scale.x *= p.scale[0]
  node.scale.y *= p.scale[1]
  node.scale.z *= p.scale[2]
}

/**
 * The animated part of a pose the gizmo has just produced.
 *
 * The gizmo reads a node back as one combined delta on its rest pose -- edit
 * and animation together. Peeling the edit off the front leaves the part the
 * keyframe should hold.
 */
export function splitPose(combined: Pose, edit: Pose): Pose {
  const spin = quat(edit.rotate).invert().multiply(quat(combined.rotate))
  return {
    move: [combined.move[0] - edit.move[0], combined.move[1] - edit.move[1], combined.move[2] - edit.move[2]],
    rotate: degrees(spin),
    scale: [
      combined.scale[0] / (edit.scale[0] || 1),
      combined.scale[1] / (edit.scale[1] || 1),
      combined.scale[2] / (edit.scale[2] || 1),
    ],
  }
}

/**
 * Put the whole model into a pose, turning and growing about `pivot`.
 *
 * The scene's own origin is wherever the exporter left it -- often a corner of
 * the model, or the floor under it -- and a spin about that would swing the
 * model round the room. So the pose is taken to be about the model's centre,
 * and the node's transform is worked out to make it so: a point p goes to
 * R·S·(p − C) + C + move. The backend gives the file a root at the pivot and
 * animates that, which lands on the same place.
 */
export function poseAbout(node: Object3D, pivot: readonly number[], p: Pose): void {
  const q = quat(p.rotate)
  const swung = new Vector3(pivot[0] * p.scale[0], pivot[1] * p.scale[1], pivot[2] * p.scale[2])
    .applyQuaternion(q)
  node.position.set(
    pivot[0] + p.move[0] - swung.x,
    pivot[1] + p.move[1] - swung.y,
    pivot[2] + p.move[2] - swung.z,
  )
  node.quaternion.copy(q)
  node.scale.set(p.scale[0], p.scale[1], p.scale[2])
}

/** The inverse of `poseAbout`: the pose about the pivot that a node transform means. */
export function unpivot(read: Pose, pivot: readonly number[]): Pose {
  const q = quat(read.rotate)
  const swung = new Vector3(pivot[0] * read.scale[0], pivot[1] * read.scale[1], pivot[2] * read.scale[2])
    .applyQuaternion(q)
  return {
    move: [read.move[0] - pivot[0] + swung.x, read.move[1] - pivot[1] + swung.y, read.move[2] - pivot[2] + swung.z],
    rotate: read.rotate,
    scale: read.scale,
  }
}

/** Seconds, the way the timeline prints them. */
export const seconds = (t: number): string => `${t.toFixed(2)} s`
