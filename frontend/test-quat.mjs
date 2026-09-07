/**
 * The quaternion arithmetic in src/animation.ts is a port of three's, kept local
 * so that an eagerly-imported module does not drag all 460 kB of three into the
 * first load. A port is only worth anything if it agrees with what it copied:
 * the viewer composes poses with the real three classes, so a drag has to read
 * back through these functions as the same pose it wrote.
 *
 * This runs both implementations over random and degenerate input and asserts
 * they agree. It is the check that fails if someone "tidies" the port.
 *
 *   node test-quat.mjs
 */
import assert from 'node:assert/strict'
import { Euler, Quaternion, Vector3 } from 'three'

// The port under test, lifted from src/animation.ts. Kept as a copy rather than
// imported because the source is TypeScript and this deliberately has no build
// step -- so the one job here is to notice when the two fall out of step.
const DEG = Math.PI / 180

function quat(rotate) {
  const c1 = Math.cos(rotate[0] * DEG / 2), s1 = Math.sin(rotate[0] * DEG / 2)
  const c2 = Math.cos(rotate[1] * DEG / 2), s2 = Math.sin(rotate[1] * DEG / 2)
  const c3 = Math.cos(rotate[2] * DEG / 2), s3 = Math.sin(rotate[2] * DEG / 2)
  return [
    s1 * c2 * c3 + c1 * s2 * s3,
    c1 * s2 * c3 - s1 * c2 * s3,
    c1 * c2 * s3 + s1 * s2 * c3,
    c1 * c2 * c3 - s1 * s2 * s3,
  ]
}

function mul(a, b) {
  return [
    a[0] * b[3] + a[3] * b[0] + a[1] * b[2] - a[2] * b[1],
    a[1] * b[3] + a[3] * b[1] + a[2] * b[0] - a[0] * b[2],
    a[2] * b[3] + a[3] * b[2] + a[0] * b[1] - a[1] * b[0],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ]
}

const conj = (q) => [-q[0], -q[1], -q[2], q[3]]

function degrees(q) {
  const [x, y, z, w] = q
  const x2 = x + x, y2 = y + y, z2 = z + z
  const xx = x * x2, xy = x * y2, xz = x * z2
  const yy = y * y2, yz = y * z2, zz = z * z2
  const wx = w * x2, wy = w * y2, wz = w * z2

  const m11 = 1 - (yy + zz), m12 = xy - wz, m13 = xz + wy
  const m22 = 1 - (xx + zz), m23 = yz - wx
  const m32 = yz + wx, m33 = 1 - (xx + yy)

  const ey = Math.asin(Math.max(-1, Math.min(1, m13)))
  const locked = Math.abs(m13) >= 0.9999999
  const ex = locked ? Math.atan2(m32, m22) : Math.atan2(-m23, m33)
  const ez = locked ? 0 : Math.atan2(-m12, m11)
  return [ex / DEG, ey / DEG, ez / DEG]
}

function rotateVec(q, v) {
  const tx = 2 * (q[1] * v[2] - q[2] * v[1])
  const ty = 2 * (q[2] * v[0] - q[0] * v[2])
  const tz = 2 * (q[0] * v[1] - q[1] * v[0])
  return [
    v[0] + q[3] * tx + q[1] * tz - q[2] * ty,
    v[1] + q[3] * ty + q[2] * tx - q[0] * tz,
    v[2] + q[3] * tz + q[0] * ty - q[1] * tx,
  ]
}

/* ---------- the three-side reference ---------- */

const refQuat = (r) => {
  const q = new Quaternion().setFromEuler(
    new Euler(r[0] * DEG, r[1] * DEG, r[2] * DEG, 'XYZ'))
  return [q.x, q.y, q.z, q.w]
}

const refDegrees = (q) => {
  const e = new Euler().setFromQuaternion(
    new Quaternion(q[0], q[1], q[2], q[3]), 'XYZ')
  return [e.x / DEG, e.y / DEG, e.z / DEG]
}

const EPS = 1e-9
let checks = 0

function same(got, want, what, input) {
  assert.equal(got.length, want.length, `${what}: arity`)
  for (let i = 0; i < got.length; i++) {
    const off = Math.abs(got[i] - want[i])
    assert.ok(
      off < EPS,
      `${what}[${i}] drifted by ${off.toExponential(3)} on ${JSON.stringify(input)}\n` +
      `  ours:  ${got[i]}\n  three: ${want[i]}`,
    )
  }
  checks++
}

/** Euler -> quaternion -> Euler, both ways, plus a vector turned by it. */
function compare(r) {
  const ours = quat(r)
  same(ours, refQuat(r), 'quat', r)
  same(degrees(ours), refDegrees(ours), 'degrees', r)

  const v = [0.37, -1.9, 4.25]
  const spun = new Vector3(...v).applyQuaternion(
    new Quaternion(ours[0], ours[1], ours[2], ours[3]))
  same(rotateVec(ours, v), [spun.x, spun.y, spun.z], 'rotateVec', r)
}

/* ---------- the cases that actually break a port ---------- */

// Gimbal lock: |m13| hits 1 at y = +-90, where three pins Z and reads X from a
// different pair of matrix elements. Straddle the 0.9999999 branch point.
const LOCK = (Math.asin(0.9999999) / DEG)
const EDGE = [
  0, 1e-9, -1e-9, 45, -45, 89.9999, 90, 90.0001, -90, 179.9999, 180, -180,
  // A key at 360 means a full turn and 720 two turns; the app relies on those
  // not collapsing to zero, so they are worth their own pass through the port.
  270, 359.9999, 360, -360, 540, 720, -720, 1080,
  LOCK, -LOCK, LOCK + 1e-6, LOCK - 1e-6,
]

for (const x of EDGE) for (const y of EDGE) compare([x, y, 0])
for (const y of EDGE) for (const z of EDGE) compare([0, y, z])
for (const x of EDGE) for (const z of EDGE) compare([x, 0, z])
for (const a of EDGE) compare([a, a, a])

// splitPose's composition: peel one turn off another and it must land where
// three's invert().multiply() lands.
for (const a of EDGE) {
  for (const b of EDGE) {
    const edit = [a, b, -a]
    const combined = [b, -a, a]
    const ours = mul(conj(quat(edit)), quat(combined))
    const three = new Quaternion(...refQuat(edit)).invert()
      .multiply(new Quaternion(...refQuat(combined)))
    same(ours, [three.x, three.y, three.z, three.w], 'mul/conj', { edit, combined })
  }
}

// And a broad random sweep, because the edge list only covers what was thought of.
let seed = 20240607
const rand = () => {
  // Deterministic, so a failure is reproducible rather than a Tuesday thing.
  seed = (seed * 1103515245 + 12345) & 0x7fffffff
  return (seed / 0x7fffffff) * 1440 - 720
}
for (let i = 0; i < 100_000; i++) compare([rand(), rand(), rand()])

console.log(`quaternion port matches three across ${checks} comparisons`)
