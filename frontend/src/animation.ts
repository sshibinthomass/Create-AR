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
import type { Clip, Keyframe, Pose, Track } from './api'

export const REST: Pose = { move: [0, 0, 0], rotate: [0, 0, 0], scale: [1, 1, 1] }

/** How long a clip runs unless the user says otherwise. */
export const DEFAULT_DURATION = 3

/** Two keys nearer than this are the same moment. */
const EPS = 1e-6

const DEG = Math.PI / 180

const lerp3 = (a: readonly number[], b: readonly number[], k: number): [number, number, number] =>
  [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k]

const pose = (k: Keyframe): Pose => ({ move: k.move, rotate: k.rotate, scale: k.scale })

/**
 * The pose a track is in `time` seconds in: held before the first key and
 * after the last, blended in a straight line between neighbours.
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
  const k = span <= 0 ? 0 : (time - a.time) / span
  return { move: lerp3(a.move, b.move, k), rotate: lerp3(a.rotate, b.rotate, k), scale: lerp3(a.scale, b.scale, k) }
}

export const isPosed = (p: Pose): boolean =>
  p.move.some((v) => v !== 0) || p.rotate.some((v) => v !== 0) || p.scale.some((v) => v !== 1)

export const track = (clip: Clip, target: string): Track | undefined =>
  clip.tracks.find((t) => t.target === target)

export const keyAt = (clip: Clip, target: string, time: number): Keyframe | undefined =>
  track(clip, target)?.keys.find((k) => Math.abs(k.time - time) < EPS)

let counter = 0

export function newClip(name: string, duration = DEFAULT_DURATION): Clip {
  counter += 1
  return { id: `${Date.now().toString(36)}-${counter}`, name, duration, tracks: [] }
}

/** The clip with one key written: replacing the key at that moment, if there is one. */
export function setKey(clip: Clip, target: string, time: number, p: Pose): Clip {
  const key: Keyframe = { time, move: p.move, rotate: p.rotate, scale: p.scale }
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
