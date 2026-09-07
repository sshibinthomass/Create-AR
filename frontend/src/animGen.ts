/**
 * Building a model's animations from its shape and from what its parts are.
 *
 * Keying a chair by hand is a hundred small decisions -- which part turns,
 * about what, how far -- and every one of them is already implied by the model.
 * A part three times longer than it is wide slides along its length. A part
 * sitting off-centre comes away outwards. A part the naming agent called a
 * castor turns. So none of this asks a model anything: the rules read the
 * geometry the viewer already measured and the descriptions the agent already
 * wrote, and produce clips. A run costs nothing and can be thrown away.
 *
 * What the agent wrote is doing real work here, though. `bolt` in a
 * description is what separates a two-turn unscrew from a slide, and no amount
 * of bounding-box arithmetic recovers it. The rules below read the name and the
 * description as one bag of words; geometry decides everything the words did
 * not.
 *
 * Every clip comes out carrying a `ClipMeta` -- what moves, which way, how far,
 * and a sentence saying so. That is not decoration. It is what lets a later
 * reader answer "how do I raise the seat?" by matching the question against a
 * hundred clips instead of replaying them, and it is written into parts.json
 * beside the model so the answer survives the export.
 *
 * One honest limitation. A keyframe's rotation turns a part about its own
 * origin, and the app has nowhere to put a per-part pivot, so `hinge` swings a
 * door about wherever the exporter left its origin. Where that is the hinge
 * line -- which is common, because that is where a modeller places a door --
 * it is exactly right; where it is the part's centre it reads as a tilt rather
 * than a swing. It still names the part and the axis, which is most of the job.
 */
import {
  WHOLE, type Clip, type ClipMeta, type Ease, type Keyframe, type MotionKind,
  type PartDetails, type Pose, type Track,
} from './api'
import { newClip, REST } from './animation'

/* ---------- how far, and for how long ---------- */

/** A quarter turn: what a lid, a door or a backrest opens through. */
const SWING = 90
/** A full turn, for anything that runs on a bearing. */
const TURN = 360
/** Two turns. Fewer does not read as undoing a thread; more is a wait. */
const UNDO = 720
/**
 * How far a part travels out of its socket, as a multiple of its own length
 * along that axis. One takes it exactly clear, which is what "removed" looks
 * like without throwing it across the room.
 */
const SLIDE = 1
/**
 * A height adjustment, as a fraction of the model's own height.
 *
 * Chosen to be seen rather than to be true: a real chair's gas lift travels
 * about a tenth of the chair's height, which at the size these are watched at
 * is a twitch. A fifth reads as "this is the thing that makes it taller".
 */
const RAISE = 0.2
/** How far a detached part is carried clear, against the model's longest side. */
const CLEAR = 0.35
/** How much a highlighted part swells before settling back. */
const SWELL = 1.25

const TRAVEL_SECONDS = 2.5
const TURN_SECONDS = 3
const SWELL_SECONDS = 1.6
const TURNTABLE_SECONDS = 6
const APART_SECONDS = 3

/* ---------- what a part's shape means ---------- */

/**
 * Longest side over the middle one, above which a part is a rod rather than a
 * block: a shaft, a leg, a bolt, a rail. Rods slide and turn about their length.
 */
const SLENDER = 3
/**
 * Thinnest side over the longest, below which a part is a panel rather than a
 * block: a seat plate, a lid, a door, a cover. Panels swing and lift.
 */
const FLAT = 0.18
/**
 * How far off the model's middle a part has to sit, against its own size,
 * before "outwards" means anything. A core buried in a housing has no outward.
 */
const OFF_CENTRE = 0.5

export type Axis = 0 | 1 | 2
const AXIS_NAME = ['x', 'y', 'z'] as const
const UP: Axis = 1

type Vec = readonly [number, number, number]
type Quat = readonly [number, number, number, number]

const len = (v: Vec): number => Math.hypot(v[0], v[1], v[2])

/** `v` at unit length, or `fallback` where it has no length to speak of. */
function unit(v: Vec, fallback: Vec): [number, number, number] {
  const n = len(v)
  return n > 1e-9 ? [v[0] / n, v[1] / n, v[2] / n] : [...fallback]
}

/** Which axis of `v` is longest, and which is shortest. */
function extremes(v: Vec): { long: Axis; thin: Axis; mid: Axis } {
  const order = ([0, 1, 2] as Axis[]).sort((a, b) => v[b] - v[a])
  return { long: order[0], mid: order[1], thin: order[2] }
}

/** `v` turned by the quaternion `q`. */
function spun(q: Quat, v: Vec): [number, number, number] {
  const [x, y, z, w] = q
  const cx = y * v[2] - z * v[1]
  const cy = z * v[0] - x * v[2]
  const cz = x * v[1] - y * v[0]
  const dx = y * cz - z * cy
  const dy = z * cx - x * cz
  const dz = x * cy - y * cx
  return [
    v[0] + 2 * (w * cx + dx),
    v[1] + 2 * (w * cy + dy),
    v[2] + 2 * (w * cz + dz),
  ]
}

/**
 * Which of the part's *own* axes points most nearly along `dir`, and whether it
 * points with it or against it.
 *
 * A box is measured along the assembly's axes; a keyframe's rotation turns the
 * part about the part's. On the great majority of exports the two agree and
 * this returns the obvious answer -- but a bolt threaded into a diagonal
 * mounting has its own frame, and a spin keyed on the assembly's Y would send
 * it wobbling instead of turning.
 */
function ownAxis(spin: Quat, dir: Vec): { axis: Axis; sign: number } {
  let axis: Axis = 0
  let best = -1
  let sign = 1
  for (const i of [0, 1, 2] as Axis[]) {
    const e: Vec = [i === 0 ? 1 : 0, i === 1 ? 1 : 0, i === 2 ? 1 : 0]
    const world = spun(spin, e)
    const dot = world[0] * dir[0] + world[1] * dir[1] + world[2] * dir[2]
    if (Math.abs(dot) > best) {
      best = Math.abs(dot)
      axis = i
      sign = dot < 0 ? -1 : 1
    }
  }
  return { axis, sign }
}

/**
 * A part reduced to the handful of facts the rules actually read.
 *
 * Everything here is in the space a move is applied in, so a distance worked
 * out from a box is a distance a keyframe can carry.
 */
export interface Shape {
  /** The name the file gives it: what a track targets and an edit is keyed on. */
  part: string
  /** The name a person would use, from the namer if it ran. */
  label: string
  /** Name and description as one lowercase string, for the word rules to read. */
  words: string
  box: Vec
  spin: Quat
  /** Longest and shortest axis of the box. */
  long: Axis
  thin: Axis
  /** Longest side over middle: a rod is slender. */
  slenderness: number
  /** Shortest side over longest: a panel is flat. */
  flatness: number
  /** Away from the model's middle, at unit length. */
  outward: [number, number, number]
  /** Whether the part sits far enough off the middle for `outward` to mean anything. */
  offCentre: boolean
}

/**
 * The geometry a run needs, in the space a move is applied in.
 *
 * Structurally what the viewer's `PartSizes` already is, spelled out here so
 * that the rules do not have to import a React component to know what a box is.
 */
export interface Geometry {
  boxes: readonly Vec[]
  centres: readonly Vec[]
  spins: readonly Quat[]
  extents: Vec
  middle: Vec
}

export interface GenInput {
  /** The parts, by the name the file gives them, in the viewer's order. */
  parts: readonly string[]
  geometry: Geometry
  /** Renames, if the parts have been named. Keyed on the file's own name. */
  labels: Readonly<Record<string, string>>
  /** What the agent said each part is. Read for words, not for structure. */
  details: Readonly<Record<string, PartDetails>>
}

/** Everything the rules know about one part, worked out once. */
export function shapeOf(input: GenInput, index: number): Shape | null {
  const { geometry: g } = input
  const part = input.parts[index]
  const box = g.boxes[index]
  const centre = g.centres[index]
  if (part === undefined || !box || !centre) return null

  const { long, mid, thin } = extremes(box)
  const label = input.labels[part] ?? part
  const written = Object.entries(input.details[part] ?? {})
    .map(([k, v]) => `${k} ${v}`).join(' ')

  const offset: Vec = [
    centre[0] - g.middle[0], centre[1] - g.middle[1], centre[2] - g.middle[2],
  ]
  const own = len(box) / 2

  return {
    part,
    label,
    words: `${label} ${written}`.toLowerCase(),
    box,
    spin: g.spins[index] ?? [0, 0, 0, 1],
    long,
    thin,
    slenderness: box[mid] > 1e-9 ? box[long] / box[mid] : SLENDER,
    flatness: box[long] > 1e-9 ? box[thin] / box[long] : 1,
    outward: unit(offset, [0, 1, 0]),
    offCentre: len(offset) > own * OFF_CENTRE,
  }
}

/* ---------- which motions a part gets ---------- */

/**
 * What the naming agent's words imply about how a part moves.
 *
 * Read in order; the first match that fires decides, because a "castor wheel
 * bolt" is a bolt and the later, more general rules would call it a wheel. The
 * words are matched against the part's name *and* its description together --
 * a part called "Cylinder 3" whose description says it telescopes is a slider,
 * and only the description knows that.
 */
const RULES: { words: RegExp; kinds: MotionKind[]; tags: string[] }[] = [
  {
    words: /\b(screw|bolt|nut|stud|thread|fastener|fixing|washer|rivet)/,
    kinds: ['unscrew', 'detach'],
    tags: ['fastener', 'loosen', 'tighten', 'undo'],
  },
  {
    words: /\b(wheel|castor|caster|roller|bearing|hub|swivel|axle|pulley|gear)/,
    kinds: ['spin', 'detach'],
    tags: ['roll', 'turn', 'free'],
  },
  {
    words: /\b(knob|dial|crank|valve|lever|handle|trigger|switch)/,
    kinds: ['spin', 'highlight'],
    tags: ['operate', 'control', 'set'],
  },
  {
    words: /\b(lid|door|cover|flap|hatch|hinge|backrest|back rest|armrest|arm rest|tilt)/,
    kinds: ['hinge', 'detach'],
    tags: ['open', 'close', 'recline', 'fold'],
  },
  {
    words: /\b(gas lift|gas spring|cylinder|piston|telescop|spindle|shaft|column|stem|rod|rail|slide|track|drawer|extension)/,
    kinds: ['raise', 'slide', 'detach'],
    tags: ['extend', 'retract', 'travel'],
  },
  {
    words: /\b(height|adjust|raise|lower|lift|elevat|recline|tension)/,
    kinds: ['raise', 'highlight'],
    tags: ['height', 'adjustment', 'setting'],
  },
  {
    words: /\b(seat|cushion|pad|shelf|tray|platform|worktop|table ?top|surface)/,
    kinds: ['raise', 'detach'],
    tags: ['height', 'sit', 'support'],
  },
  {
    words: /\b(base|frame|chassis|foot|feet|leg|stand|pedestal|mount|bracket)/,
    kinds: ['highlight', 'detach'],
    tags: ['support', 'stand', 'structure'],
  },
]

/** What the part's own proportions imply, when nothing was written about it. */
function fromShape(s: Shape): MotionKind[] {
  if (s.slenderness >= SLENDER) return s.long === UP ? ['raise', 'spin'] : ['slide', 'spin']
  if (s.flatness <= FLAT) return ['hinge', 'raise']
  return ['detach']
}

/**
 * The motions to build for one part, in the order they should be offered.
 *
 * The words decide first and the proportions fill in behind them, so a part the
 * agent described gets the better answer and a part it did not still gets one.
 * A part that cannot travel outwards -- a core sitting dead in the middle of a
 * housing -- loses `detach`, which would have buried it in its neighbours.
 */
export function motionsFor(s: Shape): { kinds: MotionKind[]; tags: string[] } {
  const rule = RULES.find((r) => r.words.test(s.words))
  const kinds = [...(rule?.kinds ?? fromShape(s))]
  // A rod standing on end raises and slides along the same axis, and "raise"
  // is the clearer of the two names for it. The other direction is not lost:
  // reversing a clip is one click, and that is what a lower is.
  if (kinds.includes('raise') && kinds.includes('slide') && s.long === UP) {
    kinds.splice(kinds.indexOf('slide'), 1)
  }
  const kept = kinds.filter((k) => k !== 'detach' || s.offCentre)
  return { kinds: kept.length ? kept : ['highlight'], tags: rule?.tags ?? [] }
}

/* ---------- building the clips ---------- */

const key = (time: number, pose: Pose, ease: Ease): Keyframe =>
  ({ time, move: pose.move, rotate: pose.rotate, scale: pose.scale, ease })

const at = (
  move: [number, number, number] = [0, 0, 0],
  rotate: [number, number, number] = [0, 0, 0],
  scale: [number, number, number] = [1, 1, 1],
): Pose => ({ move, rotate, scale })

/** A pose that moves `distance` along `dir`. */
const along = (dir: Vec, distance: number): Pose =>
  at([dir[0] * distance, dir[1] * distance, dir[2] * distance])

/** A pose that turns `degrees` about the part's own axis `axis`. */
function about(axis: Axis, degrees: number): Pose {
  const turn: [number, number, number] = [0, 0, 0]
  turn[axis] = degrees
  return at([0, 0, 0], turn)
}

/** Two poses, held at rest and then arrived at. What most of these clips are. */
const journey = (to: Pose, seconds: number, ease: Ease): Track['keys'] =>
  [key(0, REST, ease), key(seconds, to, ease)]

/**
 * How the motion is described, once it is known which way and how far it went.
 *
 * `axis` and `amount` are here to be read by something choosing between clips
 * rather than watching them -- "the one that moves it up" is a question about
 * the Y axis, and no amount of reading `summary` answers it as cheaply.
 */
function meta(
  kind: MotionKind, s: Shape, axis: Axis | null, amount: number,
  summary: string, tags: readonly string[],
): ClipMeta {
  return {
    kind,
    targets: [s.part],
    labels: [s.label],
    axis: axis === null ? '' : AXIS_NAME[axis],
    amount: Math.round(amount * 1000) / 1000,
    summary,
    tags: [...new Set([kind, ...tags, ...words(s.label)])],
  }
}

/** The words of a label, as a question might use them. */
const words = (label: string): string[] =>
  label.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2)

/** A length as it should read in a sentence: enough digits to mean something. */
const size = (n: number): string =>
  n >= 100 ? n.toFixed(0) : n >= 1 ? n.toFixed(2) : n.toPrecision(2)

/**
 * A label as it reads mid-sentence.
 *
 * The namer writes "Gas lift cylinder", so "Raise the Gas lift cylinder" comes
 * out shouting. Only the first letter is touched, and only when the rest of
 * that word is already lowercase -- which leaves "M8 bolt" and "USB port"
 * exactly as the namer wrote them.
 */
function inline(label: string): string {
  const rest = (label.split(' ')[0] ?? '').slice(1)
  // Only a word that carries on in lower case is an ordinary word. "USB" keeps
  // its capital because the rest shouts; "M6" keeps its because the rest is a
  // number and says nothing either way.
  if (!/[a-z]/.test(rest) || /[A-Z]/.test(rest)) return label
  return label.charAt(0).toLowerCase() + label.slice(1)
}

/** One motion, as a clip. Null where the geometry gives it nowhere to go. */
function build(kind: MotionKind, s: Shape, g: Geometry, tags: string[]): Clip | null {
  const it = inline(s.label) || 'part'
  const span = Math.max(g.extents[0], g.extents[1], g.extents[2]) || 1

  switch (kind) {
    case 'spin': {
      const dir: Vec = [s.long === 0 ? 1 : 0, s.long === 1 ? 1 : 0, s.long === 2 ? 1 : 0]
      const { axis } = ownAxis(s.spin, dir)
      return clip(`Spin the ${it}`, TURN_SECONDS,
        s.part, journey(about(axis, TURN), TURN_SECONDS, 'linear'),
        meta('spin', s, s.long, TURN,
          `Turns "${s.label}" a full 360° about its ${AXIS_NAME[s.long]} axis, the way it runs in service.`,
          ['rotate', 'turn', 'revolve', ...tags]))
    }

    case 'unscrew': {
      const dir: Vec = [s.long === 0 ? 1 : 0, s.long === 1 ? 1 : 0, s.long === 2 ? 1 : 0]
      const { axis, sign } = ownAxis(s.spin, dir)
      const out = s.outward[s.long] < 0 ? -1 : 1
      const travel = s.box[s.long] * SLIDE * 1.5
      // Turning and backing out at once, because that is what undoing a thread
      // is. Three keys rather than two: the fastener should already be moving
      // by the time it clears, not start travelling after the turns are done.
      const half = about(axis, (UNDO / 2) * sign)
      const clear = about(axis, UNDO * sign)
      const step = (travel / 2) * out
      const keys = [
        key(0, REST, 'linear'),
        key(TRAVEL_SECONDS / 2, offsetAlong(half, s.long, step), 'linear'),
        key(TRAVEL_SECONDS, offsetAlong(clear, s.long, step * 2), 'smooth'),
      ]
      return clip(`Unscrew the ${it}`, TRAVEL_SECONDS, s.part, keys,
        meta('unscrew', s, s.long, UNDO,
          `Backs "${s.label}" out along ${AXIS_NAME[s.long]} over two turns, travelling ${size(travel)} clear.`,
          ['remove', 'loosen', 'undo', 'fastener', ...tags]))
    }

    case 'hinge': {
      const line = hingeAxis(s)
      const dir: Vec = [line === 0 ? 1 : 0, line === 1 ? 1 : 0, line === 2 ? 1 : 0]
      const { axis } = ownAxis(s.spin, dir)
      const sign = swingSign(s, line)
      return clip(`Swing the ${it} open`, TRAVEL_SECONDS,
        s.part, journey(about(axis, SWING * sign), TRAVEL_SECONDS, 'smooth'),
        meta('hinge', s, line, SWING * sign,
          `Swings "${s.label}" through 90° about its ${AXIS_NAME[line]} axis, opening it away from the assembly.`,
          ['open', 'close', 'swing', 'fold', 'recline', 'access', ...tags]))
    }

    case 'slide': {
      const axis = s.long
      const out = s.outward[axis] < 0 ? -1 : 1
      const travel = s.box[axis] * SLIDE
      if (travel <= 1e-9) return null
      const dir: Vec = [axis === 0 ? out : 0, axis === 1 ? out : 0, axis === 2 ? out : 0]
      return clip(`Slide the ${it} out`, TRAVEL_SECONDS,
        s.part, journey(along(dir, travel), TRAVEL_SECONDS, 'smooth'),
        meta('slide', s, axis, travel * out,
          `Slides "${s.label}" ${size(travel)} along ${AXIS_NAME[axis]}, its own length clear of where it sits.`,
          ['extend', 'withdraw', 'pull out', 'travel', ...tags]))
    }

    case 'raise': {
      const travel = Math.max(g.extents[1] * RAISE, s.box[UP] * 0.5)
      if (travel <= 1e-9) return null
      return clip(`Raise the ${it}`, TRAVEL_SECONDS,
        s.part, journey(along([0, 1, 0], travel), TRAVEL_SECONDS, 'smooth'),
        meta('raise', s, UP, travel,
          `Lifts "${s.label}" ${size(travel)} straight up — ${Math.round((travel / (g.extents[1] || 1)) * 100)}% of the model's height. Reverse it to lower.`,
          ['height', 'taller', 'higher', 'adjust', 'lift', 'up', ...tags]))
    }

    case 'detach': {
      const travel = span * CLEAR
      if (travel <= 1e-9) return null
      const { axis } = biggest(s.outward)
      return clip(`Take the ${it} off`, TRAVEL_SECONDS,
        s.part, journey(along(s.outward, travel), TRAVEL_SECONDS, 'smooth'),
        meta('detach', s, axis, travel,
          `Carries "${s.label}" ${size(travel)} clear of the assembly, away from its middle.`,
          ['remove', 'detach', 'replace', 'fit', 'take off', ...tags]))
    }

    case 'highlight': {
      const swell = at([0, 0, 0], [0, 0, 0], [SWELL, SWELL, SWELL])
      const keys = [
        key(0, REST, 'smooth'),
        key(SWELL_SECONDS / 2, swell, 'smooth'),
        key(SWELL_SECONDS, REST, 'smooth'),
      ]
      return clip(`Show the ${it}`, SWELL_SECONDS, s.part, keys,
        meta('highlight', s, null, SWELL,
          `Swells "${s.label}" to ${SWELL}× and settles it back, to pick it out of the assembly.`,
          ['locate', 'find', 'identify', 'which', 'where', 'point out', ...tags]))
    }

    default:
      return null
  }
}

/** `pose` with a translation added along one of the assembly's axes. */
function offsetAlong(pose: Pose, axis: Axis, distance: number): Pose {
  const move: [number, number, number] = [...pose.move]
  move[axis] += distance
  return { ...pose, move }
}

/** Which axis of a direction dominates, and which way it points along it. */
function biggest(dir: Vec): { axis: Axis; sign: number } {
  let axis: Axis = 0
  for (const i of [1, 2] as Axis[]) if (Math.abs(dir[i]) > Math.abs(dir[axis])) axis = i
  return { axis, sign: dir[axis] < 0 ? -1 : 1 }
}

/**
 * Above this ratio an upright panel is a door and swings about its vertical
 * edge; at or under it, it is a back or a lid and folds about its horizontal
 * one. A door is markedly taller than it is wide, which is what makes the two
 * tellable apart at all -- a panel that is nearly square could be either, and
 * folding is the commoner of the two.
 */
const DOOR = 1.5

/**
 * The line a panel turns about: one of the two axes it actually lies in.
 *
 * Never the thin one -- turning a panel about its own thickness spins it in its
 * own plane, which is not a hinge. Between the other two, the long one, except
 * for the upright near-square case the constant above describes.
 */
function hingeAxis(s: Shape): Axis {
  const across = ([0, 1, 2] as Axis[]).filter((i) => i !== s.thin)
  const [a, b] = across[0] === s.long ? across : [across[1], across[0]]
  if (a === UP && s.box[a] / (s.box[b] || 1) <= DOOR) return b
  return a
}

/**
 * Which way it opens: away from the assembly rather than into it.
 *
 * A turn about `axis` carries the part's top round in the direction
 * `axis × up`, so the sign is the one that sends that the same way the part
 * already leans -- a backrest above and behind the chair's middle tips further
 * back, which is what reclining is.
 *
 * A panel hinged about the vertical has no top to carry anywhere and the cross
 * product vanishes. That case is not undecided, it is genuinely arbitrary: a
 * door opens the way its hinges are, and where the hinges are is not in the
 * geometry. It opens positively, and reversing the clip is one click.
 */
function swingSign(s: Shape, axis: Axis): number {
  // axis x up, for axis one of the three unit vectors: only the two axes that
  // are not Y give anything, and each gives a single signed unit vector.
  const swept: Vec = axis === 0 ? [0, 0, 1] : axis === 2 ? [-1, 0, 0] : [0, 0, 0]
  const lean = swept[0] * s.outward[0] + swept[2] * s.outward[2]
  return lean < 0 ? -1 : 1
}

/** A clip with a single track on a single part. */
function clip(
  name: string, duration: number, target: string, keys: Keyframe[], info: ClipMeta,
): Clip {
  return { ...newClip(name, duration), tracks: [{ target, keys }], meta: info }
}

/* ---------- the whole model ---------- */

/** The model turning on the spot: the one clip every product wants. */
function turntable(pivot: Vec): Clip {
  return {
    ...newClip('Turn the model around', TURNTABLE_SECONDS),
    tracks: [{
      target: WHOLE,
      pivot: [pivot[0], pivot[1], pivot[2]],
      keys: journey(about(UP, TURN), TURNTABLE_SECONDS, 'linear'),
    }],
    meta: {
      kind: 'turntable',
      targets: [WHOLE],
      labels: ['the whole model'],
      axis: 'y',
      amount: TURN,
      summary: 'Turns the whole model through 360° about its vertical axis, to see it from every side.',
      tags: ['turntable', 'overview', 'inspect', 'all round', 'look at'],
    },
  }
}

/**
 * Every part carried outwards at once.
 *
 * The one clip that is worth more than the sum of the single-part ones: it says
 * how the assembly goes together, which no clip about one part can. Each part
 * travels along its own outward direction and by how far off-centre it already
 * sits, so the arrangement stays recognisable instead of collapsing into an
 * even starburst -- the same reasoning as the viewer's own explode slider.
 */
function explode(shapes: readonly Shape[], g: Geometry): Clip | null {
  const span = Math.max(g.extents[0], g.extents[1], g.extents[2]) || 1
  const tracks: Track[] = shapes.map((s) => ({
    target: s.part,
    keys: journey(along(s.outward, span * CLEAR), APART_SECONDS, 'smooth'),
  }))
  if (!tracks.length) return null
  return {
    ...newClip('Take the model apart', APART_SECONDS),
    tracks,
    meta: {
      kind: 'explode',
      targets: shapes.map((s) => s.part),
      labels: shapes.map((s) => s.label),
      axis: '',
      amount: span * CLEAR,
      summary: `Carries all ${shapes.length} parts outwards at once, into an exploded view. Reverse it for the assembly.`,
      tags: ['explode', 'exploded view', 'disassemble', 'assemble', 'overview',
        'how it fits', 'parts'],
    },
  }
}

/* ---------- the run ---------- */

/**
 * Which motions a run is asked for, grouped the way the user thinks about them.
 *
 * Not one switch per `MotionKind`: nobody wants "unscrew but not spin". The
 * groups are the three things a transform can do, plus the model as one.
 */
export interface Wanted {
  /** spin, hinge, unscrew. */
  turns: boolean
  /** slide, raise, detach. */
  travels: boolean
  /** highlight: the swell that picks a part out of a crowd. */
  highlights: boolean
  /** turntable and explode, which move the model rather than a part. */
  whole: boolean
}

export const ALL_WANTED: Wanted = {
  turns: true, travels: true, highlights: true, whole: true,
}

const GROUP: Record<MotionKind, keyof Wanted | null> = {
  spin: 'turns', hinge: 'turns', unscrew: 'turns',
  slide: 'travels', raise: 'travels', detach: 'travels',
  highlight: 'highlights',
  turntable: 'whole', explode: 'whole',
  merged: null,
}

/**
 * Give two clips that ended up with the same name something to tell them apart.
 *
 * Where the parts differ in position -- four castors, two armrests -- say where
 * each one is, which is what a person would have said. Where they do not, fall
 * back to numbering: two identical parts in the same place have nothing to
 * distinguish them but their order in the file.
 */
function distinguish(clips: Clip[], shapes: Map<string, Shape>): Clip[] {
  const group = (all: readonly Clip[]): Clip[][] => {
    const by = new Map<string, Clip[]>()
    for (const c of all) {
      const same = by.get(c.name)
      if (same) same.push(c)
      else by.set(c.name, [c])
    }
    return [...by.values()].filter((same) => same.length > 1)
  }

  for (const same of group(clips)) {
    for (const c of same) {
      const s = shapes.get(c.meta?.targets[0] ?? '')
      const where = s ? place(s) : ''
      if (where) c.name = `${c.name} (${where})`
    }
  }
  // Two parts in the same corner have nothing to tell them apart but their
  // order in the file. Only the ones still clashing are numbered -- the four
  // castors that did get a corner each keep it.
  for (const same of group(clips)) {
    same.forEach((c, i) => {
      // Inside the corner it already has, rather than a second bracket after it.
      c.name = c.name.endsWith(')')
        ? `${c.name.slice(0, -1)} ${i + 1})`
        : `${c.name} (${i + 1})`
    })
  }
  return clips
}

/** Where a part sits, in the words someone would use: 'front left', 'upper'. */
function place(s: Shape): string {
  const said: string[] = []
  if (Math.abs(s.outward[1]) > 0.45) said.push(s.outward[1] > 0 ? 'upper' : 'lower')
  if (Math.abs(s.outward[2]) > 0.35) said.push(s.outward[2] > 0 ? 'front' : 'back')
  if (Math.abs(s.outward[0]) > 0.35) said.push(s.outward[0] > 0 ? 'right' : 'left')
  return said.join(' ')
}

export interface GenResult {
  clips: Clip[]
  /** How many parts the run actually looked at. */
  parts: number
}

/**
 * Every animation the rules can make for a model.
 *
 * Ordered part by part rather than motion by motion, so the list reads as a
 * walk through the assembly. The whole-model clips come first because they are
 * the ones anyone opening the model wants to watch before anything else.
 */
export function generate(
  input: GenInput, wanted: Wanted = ALL_WANTED,
  /**
   * The model's centre, for the turntable to turn about. In the whole-model
   * track's own space, which is the viewer's measurement -- not the parent
   * space the boxes are in, and never mixed with them.
   */
  pivot: Vec = [0, 0, 0],
): GenResult {
  const shapes = input.parts
    .map((_, i) => shapeOf(input, i))
    .filter((s): s is Shape => s !== null)

  const clips: Clip[] = []
  if (wanted.whole && shapes.length) {
    clips.push(turntable(pivot))
    const apart = explode(shapes, input.geometry)
    if (apart) clips.push(apart)
  }

  for (const s of shapes) {
    const { kinds, tags } = motionsFor(s)
    for (const kind of kinds) {
      const group = GROUP[kind]
      if (!group || !wanted[group]) continue
      const made = build(kind, s, input.geometry, tags)
      if (made) clips.push(made)
    }
    // The swell is the clip a question about *which* part is answered with, so
    // it is offered for every part rather than only where a rule asked for it.
    if (wanted.highlights && !kinds.includes('highlight')) {
      const made = build('highlight', s, input.geometry, tags)
      if (made) clips.push(made)
    }
  }

  const byPart = new Map(shapes.map((s) => [s.part, s]))
  return { clips: distinguish(clips, byPart), parts: shapes.length }
}

/**
 * How many clips a run would produce.
 *
 * A forty-part assembly makes well over a hundred animations, and the number is
 * worth seeing before the list is a hundred rows longer. Worked out by running
 * the generator and counting rather than by adding up what the rules ought to
 * produce: a motion the geometry leaves nowhere to go is dropped in `build`,
 * and a count that did its own arithmetic would promise clips that never
 * arrived. Building them costs a few thousand small objects, once per change of
 * the switches.
 */
export const count = (input: GenInput, wanted: Wanted = ALL_WANTED): number =>
  generate(input, wanted).clips.length
