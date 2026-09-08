/**
 * The field the whole interface floats on.
 *
 * Every panel in this app is a veil over a depth, and this is the depth: a box
 * of points held in 3D and projected to the screen, with the camera drifting a
 * fraction of a degree and answering the pointer. It is what makes the model
 * look like it is being held in something rather than sitting in a box.
 *
 * Two decisions worth knowing, because both look like the wrong choice:
 *
 * It draws to a 2D canvas, not WebGL, though it is genuinely 3D -- the points
 * are perspective-divided by their own z. That is deliberate. `three` was
 * deliberately code-split out of this app's first load, and a mounted r3f
 * canvas behind every route would drag all 460 kB of it straight back in for
 * the sake of the background. It would also hold a second WebGL context open
 * for the whole session, next to the one the model viewer actually needs. A
 * few hundred projected points cost neither.
 *
 * ponytail: a 2D canvas caps this at points. The design system's own field
 * morphs into solid objects per route, which needs real geometry -- if that is
 * ever wanted here, this becomes an r3f scene lazy-loaded after first paint,
 * not an eager import.
 *
 * Reduced motion gets a still field rather than an empty one. The design
 * system's own component renders nothing at all in that case, but "no motion"
 * is what was asked for, not "no background", and the light theme in
 * particular looks unfinished without the texture. One frame, no loop.
 */
import { useEffect, useRef } from 'react'
import { cssColor, useThemeValue } from '../theme'

const COUNT = 420

/** How far a point at the front of the field slides under a full pointer sweep. */
const PARALLAX = 78

type Point = { u: number; v: number; z: number; twinkle: number }

/**
 * Points scattered through the frustum, sorted far-to-near so the near ones
 * paint last and the field reads as having a front and a back.
 *
 * Positions are held as where the point lands on screen (u, v) paired with the
 * depth it sits at (z), rather than as a position in a box. Both describe the
 * same frustum -- a box position would be x = u * z -- but this way round the
 * distribution is even at every depth. Scattering through a box instead sends
 * everything near the camera far outside the viewport, which is a fine way to
 * build a field that draws almost nothing.
 */
function scatter(): Point[] {
  const points: Point[] = Array.from({ length: COUNT }, () => ({
    // Overscanned past the edges, because the field parallaxes under the
    // pointer and a distribution that stopped at the viewport would pull a
    // visible empty margin in behind it.
    u: (Math.random() - 0.5) * 2.4,
    v: (Math.random() - 0.5) * 2.4,
    z: 0.4 + Math.random() * 1.8,
    twinkle: Math.random() * Math.PI * 2,
  }))
  return points.sort((a, b) => b.z - a.z)
}

export default function PointField() {
  const canvas = useRef<HTMLCanvasElement>(null)
  // The scene draws itself rather than through CSS, so it reads the theme
  // back out at runtime the same way the model viewer does.
  const theme = useThemeValue()

  useEffect(() => {
    const el = canvas.current
    if (!el) return
    const ctx = el.getContext('2d')
    if (!ctx) return

    const still =
      window.matchMedia('(prefers-reduced-motion: reduce)').matches ||
      // Chromium-only, and absent everywhere else, so it is read defensively.
      Boolean((navigator as { connection?: { saveData?: boolean } }).connection?.saveData)

    const points = scatter()
    const near = cssColor('--accent')
    const far = cssColor('--dim')

    let width = 0
    let height = 0
    // Capped: a 3x retina panel would otherwise cost nine times the fill for a
    // background nobody is inspecting.
    const dpr = Math.min(window.devicePixelRatio || 1, 2)

    const measure = () => {
      width = el.clientWidth
      height = el.clientHeight
      el.width = Math.round(width * dpr)
      el.height = Math.round(height * dpr)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }
    measure()

    // Pointer parallax, held as a target the camera eases towards, so moving
    // the mouse quickly does not snap the field.
    let wantX = 0
    let wantY = 0
    let camX = 0
    let camY = 0

    const onPointer = (e: PointerEvent) => {
      wantX = (e.clientX / window.innerWidth - 0.5) * 2
      wantY = (e.clientY / window.innerHeight - 0.5) * 2
    }

    const draw = (elapsed: number) => {
      // The one orchestrated motion in the app: the field settles into place
      // once, on load, and is otherwise still enough to ignore. A still field
      // starts already settled.
      const settle = still ? 1 : Math.min(elapsed / 1100, 1)
      const eased = 1 - (1 - settle) ** 3

      camX += (wantX - camX) * 0.04
      camY += (wantY - camY) * 0.04

      // A slow figure-of-eight under the pointer offset, so an untouched page
      // is not completely static but never appears to be moving either.
      const t = still ? 0 : elapsed / 1000
      const driftX = Math.sin(t * 0.05) * 0.06 + camX * 0.07
      const driftY = Math.cos(t * 0.04) * 0.04 + camY * 0.05

      ctx.clearRect(0, 0, width, height)
      const halfW = width / 2
      const halfH = height / 2

      for (const p of points) {
        // Settling spreads the field outward from the centre into its real
        // shape, so the points appear to arrive rather than to fade in.
        const spread = 0.86 + 0.14 * eased
        // The perspective divide: one over depth, so the near points slide
        // furthest under the pointer and the far ones barely move at all.
        const sx = halfW + p.u * halfW * spread - (driftX / p.z) * PARALLAX
        const sy = halfH + p.v * halfH * spread - (driftY / p.z) * PARALLAX
        if (sx < -4 || sx > width + 4 || sy < -4 || sy > height + 4) continue

        // Nearer points are bigger, brighter, and drawn in the accent; the far
        // ones recede into the dim grey. Depth is carried by all three at once
        // because any one of them alone reads as noise.
        const depth = Math.min(Math.max((2.2 - p.z) / 1.8, 0), 1)
        const radius = 0.55 + depth * 1.25
        const flicker = still ? 1 : 0.82 + Math.sin(t * 0.7 + p.twinkle) * 0.18

        ctx.globalAlpha = (0.14 + depth * 0.46) * flicker * eased
        ctx.fillStyle = depth > 0.55 ? near : far
        ctx.beginPath()
        ctx.arc(sx, sy, radius, 0, Math.PI * 2)
        ctx.fill()
      }
      ctx.globalAlpha = 1
    }

    if (still) {
      const resize = new ResizeObserver(() => { measure(); draw(0) })
      resize.observe(el)
      draw(0)
      return () => resize.disconnect()
    }

    let frame = 0
    let started = 0
    const loop = (now: number) => {
      if (!started) started = now
      draw(now - started)
      frame = requestAnimationFrame(loop)
    }
    frame = requestAnimationFrame(loop)

    // A background field is exactly the thing that should not keep a laptop
    // awake behind another window.
    const onVisibility = () => {
      if (document.hidden) cancelAnimationFrame(frame)
      else frame = requestAnimationFrame(loop)
    }

    const resize = new ResizeObserver(measure)
    resize.observe(el)
    window.addEventListener('pointermove', onPointer, { passive: true })
    document.addEventListener('visibilitychange', onVisibility)

    return () => {
      cancelAnimationFrame(frame)
      resize.disconnect()
      window.removeEventListener('pointermove', onPointer)
      document.removeEventListener('visibilitychange', onVisibility)
    }
    // Re-read the palette and restart when the theme moves under it.
  }, [theme])

  return <canvas ref={canvas} className="point-field-layer" aria-hidden="true" />
}
