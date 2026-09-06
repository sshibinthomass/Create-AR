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
  /**
   * Whether the end of the clip runs back to the start.
   *
   * On while you are building a movement, because a step you are timing wants
   * watching over and over; off when you want to see the assembly end where it
   * ends, and stay there.
   */
  looping = true
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

  setLooping(on: boolean): void {
    this.looping = on
    this.notify()
  }

  setDuration(d: number): void {
    this.duration = Math.max(0.01, d)
    if (this.time > this.duration) this.time = this.duration
    this.notify()
  }

  play(): void {
    if (this.playing) return
    // Played once and resting on the last frame, Play means "again" -- there
    // is nowhere else it could mean, and no reason to make you rewind first.
    if (!this.looping && this.time >= this.duration) this.time = 0
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
    const next = this.time + dt
    if (next < this.duration || this.duration <= 0) {
      this.time = this.duration > 0 ? next : 0
    } else if (this.looping) {
      // A movement being built is looked at over and over, and a playhead that
      // hits the end and stops asks to be dragged back every time.
      this.time = next % this.duration
    } else {
      // Played once: rest on the last frame, which for an assembly study is
      // the finished state and the thing worth looking at.
      this.time = this.duration
      this.pause()
      return
    }
    this.notify()
    this.frame = requestAnimationFrame(this.tick)
  }
}
