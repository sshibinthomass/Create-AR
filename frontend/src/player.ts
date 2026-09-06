/**
 * The clock a clip plays to.
 *
 * Kept outside React on purpose. The viewer reads the time on every frame it
 * draws, and the timeline redraws its playhead just as often; if the time were
 * React state in the Analysis view, every tick would re-render the parts list
 * and everything else on the page along with them. Instead anything that needs
 * the time subscribes, and only those parts of the page follow the clock.
 */
export class Player {
  time = 0
  playing = false
  duration = 1
  /** Bumped on every change, so a subscriber can tell a tick from a re-render. */
  version = 0

  private listeners = new Set<() => void>()
  private frame = 0
  private last = 0

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn)
    return () => { this.listeners.delete(fn) }
  }

  snapshot = (): number => this.version

  private notify() {
    this.version += 1
    for (const fn of this.listeners) fn()
  }

  seek(t: number): void {
    this.time = Math.max(0, Math.min(this.duration, t))
    this.notify()
  }

  setDuration(d: number): void {
    this.duration = Math.max(0.01, d)
    if (this.time > this.duration) this.time = this.duration
    this.notify()
  }

  play(): void {
    if (this.playing) return
    this.playing = true
    this.last = performance.now()
    this.frame = requestAnimationFrame(this.tick)
    this.notify()
  }

  pause(): void {
    if (!this.playing) return
    this.playing = false
    cancelAnimationFrame(this.frame)
    this.notify()
  }

  toggle(): void {
    if (this.playing) this.pause()
    else this.play()
  }

  /** Stop and go back to the start. */
  stop(): void {
    this.pause()
    this.seek(0)
  }

  private tick = (now: number) => {
    const dt = (now - this.last) / 1000
    this.last = now
    // Loops: a clip made here is a movement to be looked at over and over,
    // and a playhead that hits the end and stops asks to be dragged back.
    this.time = this.duration > 0 ? (this.time + dt) % this.duration : 0
    this.notify()
    this.frame = requestAnimationFrame(this.tick)
  }
}
