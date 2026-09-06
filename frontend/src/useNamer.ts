import { useCallback, useRef, useState } from 'react'
import {
  nameParts,
  type NamerSettings, type PartDetails, type PartShotPayload,
} from './api'

/** Names carried into the prompt as "already used"; enough to stop repeats. */
const RECENT_NAMES = 60

/**
 * Number the names that turned out not to be unique.
 *
 * Four identical brackets look identical to the model too, and it will call all
 * four "Bracket" -- rightly, since that is what they are. Two chunks in flight
 * at once cannot see each other's answers either, so even distinct parts can
 * collide. Every part sharing a name is numbered, "Bracket #1" through
 * "Bracket #4"; a name only one part holds is left exactly as it came.
 *
 * The whole set is rebuilt from scratch on every chunk rather than patched,
 * because a duplicate only becomes visible when the *second* part arrives -- by
 * which time the first is already in the list under its plain name and has to
 * be numbered after the fact. Numbering follows the part order in the list, not
 * the order the replies happened to come back in.
 *
 * Case is ignored when matching, so "Hex Bolt" and "hex bolt" count as the same
 * name; each keeps its own spelling.
 */
export function numbered(
  given: ReadonlyMap<number, string>,
  parts: readonly string[],
): Record<string, string> {
  const order = [...given.keys()].sort((a, b) => a - b)
  const fold = (name: string) => name.toLowerCase()

  const held = new Map<string, number>()
  for (const at of order) {
    const key = fold(given.get(at)!)
    held.set(key, (held.get(key) ?? 0) + 1)
  }

  const nth = new Map<string, number>()
  const out: Record<string, string> = {}
  for (const at of order) {
    const name = given.get(at)!
    const key = fold(name)
    if (held.get(key)! < 2) {
      out[parts[at]] = name
      continue
    }
    const n = (nth.get(key) ?? 0) + 1
    nth.set(key, n)
    out[parts[at]] = `${name} #${n}`
  }
  return out
}

/**
 * Ask the model about one part, on its own.
 *
 * The same request the batch run makes, for a single part: the dialog for one
 * component needs to be able to re-ask about that component without putting a
 * hundred-part assembly through the renderer again. `total` and `taken` still
 * travel, because "one of 112" and "these names are already used" are what stop
 * the answer being a guess made in isolation.
 */
export async function nameOnePart(
  url: string,
  index: number,
  /** How many parts the model has, so the request can say where this one sits. */
  total: number,
  /** The names the other parts are going by, so the answer avoids repeating one. */
  taken: readonly string[],
  settings: NamerSettings,
): Promise<{ name: string; details: PartDetails }> {
  const { openStudio } = await import('./partShots')
  const studio = await openStudio(url)
  if (!studio) throw new Error('This model has no separate parts to name.')
  let shot: PartShotPayload
  try {
    if (index >= studio.names.length) {
      throw new Error('The model changed while this part was being rendered.')
    }
    shot = {
      index,
      name: studio.names[index],
      isolated: studio.isolated(index),
      context: settings.context_shot ? studio.inContext(index) : '',
    }
  } finally {
    studio.close()
  }

  const reply = await nameParts(
    [shot], Math.max(total, 1), taken.slice(-RECENT_NAMES), settings.describe)
  const named = reply.names.find((n) => n.index === index) ?? reply.names[0]
  if (!named) throw new Error('The model did not name this part.')
  return { name: named.name, details: named.details ?? {} }
}


/**
 * Render every part, then ask the model what each one is.
 *
 * The parts are cut into chunks -- one part each, or `batch_size` of them -- and
 * a small pool of requests works through the chunks in parallel. Naming a
 * hundred-part assembly one part at a time is a hundred round trips, and doing
 * them strictly in order would take minutes of mostly waiting.
 *
 * Names are handed back chunk by chunk rather than at the end, so they land in
 * the list as they arrive. That also means a run that fails halfway keeps what
 * it already named.
 */
export function useNamer() {
  const [busy, setBusy] = useState(false)
  const [step, setStep] = useState('')
  const [done, setDone] = useState(0)
  const [total, setTotal] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const stopped = useRef(false)

  const stop = useCallback(() => { stopped.current = true }, [])

  const run = useCallback(async (
    url: string,
    parts: readonly string[],
    settings: NamerSettings,
    onNamed: (names: Record<string, string>, details: Record<string, PartDetails>) => void,
  ) => {
    setError(null)
    setBusy(true)
    stopped.current = false
    try {
      setStep('Rendering parts')
      setDone(0)
      setTotal(parts.length)
      // Loaded on demand: it pulls in three.js and a glTF loader, which the
      // Convert tab has no use for and should not be made to download.
      const { capturePartShots } = await import('./partShots')
      const shots = await capturePartShots(
        url, settings.context_shot, (at, of) => { setDone(at); setTotal(of) },
      )
      if (stopped.current) return
      if (!shots.length) {
        throw new Error('This model has no separate parts to name.')
      }
      if (shots.length !== parts.length) {
        throw new Error('The model changed while its parts were being rendered.')
      }

      const size = settings.mode === 'batch' ? Math.max(1, settings.batch_size) : 1
      const chunks: PartShotPayload[][] = []
      for (let at = 0; at < shots.length; at += size) chunks.push(shots.slice(at, at + size))

      setStep('Naming parts')
      setDone(0)
      setTotal(shots.length)

      const taken: string[] = []
      // Every name the model has given so far, by part. Kept whole because the
      // numbering below has to be worked out across the run, not per chunk.
      const given = new Map<number, string>()
      // What each part turned out to be, keyed the way `renames` is -- by the
      // name the *file* uses, which is what survives into the parts document.
      const told: Record<string, PartDetails> = {}
      let next = 0
      let named = 0
      let failure: Error | null = null

      const worker = async () => {
        while (!stopped.current) {
          const mine = chunks[next++]
          if (!mine) return
          try {
            const reply = await nameParts(
              mine, shots.length, taken.slice(-RECENT_NAMES), settings.describe,
            )
            if (stopped.current) return
            for (const { index, name, details } of reply.names) {
              const original = parts[index]
              if (original === undefined) continue
              given.set(index, name)
              taken.push(name)
              if (details && Object.keys(details).length) told[original] = details
            }
            named += mine.length
            setDone(named)
            onNamed(numbered(given, parts), { ...told })
          } catch (e) {
            // One bad chunk ends the run: the rest would almost always fail the
            // same way, and whatever has already been named is kept.
            failure ??= e as Error
            stopped.current = true
          }
        }
      }

      await Promise.all(
        Array.from({ length: Math.min(settings.concurrency, chunks.length) }, worker),
      )
      if (failure) throw failure
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
      setStep('')
    }
  }, [])

  return { busy, step, done, total, error, setError, run, stop }
}
