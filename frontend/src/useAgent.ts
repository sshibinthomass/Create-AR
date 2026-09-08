import { useCallback, useRef, useState } from 'react'
import {
  startAgent, stepAgent, stopAgent,
  type AgentAsk, type AgentNamed, type AgentStep, type PartDetails,
} from './api'
import { numbered } from './useNamer'

/** A question waiting on the user, with the picture the agent was looking at. */
export interface PendingAsk {
  ask: AgentAsk
  image: string
}

/** What the run turned out to be, once it has finished. */
export interface RunReport {
  subject: string
  summary: string
  /** Parts the agent named but was not sure of, worth a human glance. */
  unsure: { index: number; name: string; evidence: string }[]
}

/** Let the page paint between renders; a batch is a handful of them. */
const breathe = () => new Promise((done) => setTimeout(done, 0))

/**
 * Drive the naming agent.
 *
 * The loop itself lives on the server -- see backend/app/agent.py -- because
 * that is where the transcript and the API key are. This is the half that can
 * see: it renders whatever the last step asked for, puts any question to the
 * user, and posts both back.
 *
 *   survey -> [ render -> (ask) -> step ] -> report
 *
 * Names land as each step returns rather than at the end, so the list fills in
 * while the run is still going and a run that fails halfway keeps what it had.
 */
export function useAgent() {
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')
  const [phase, setPhase] = useState('')
  const [subject, setSubject] = useState('')
  const [done, setDone] = useState(0)
  const [total, setTotal] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [asking, setAsking] = useState<PendingAsk | null>(null)
  const [report, setReport] = useState<RunReport | null>(null)

  const stopped = useRef(false)
  const session = useRef('')
  // Set while a question is on screen; calling it lets the loop go on.
  const waiting = useRef<((answer: string) => void) | null>(null)

  const settle = useCallback((answer: string) => {
    const resolve = waiting.current
    waiting.current = null
    setAsking(null)
    resolve?.(answer)
  }, [])

  /** The user answered the question on screen. */
  const answer = useCallback((text: string) => settle(text), [settle])

  const stop = useCallback(() => {
    stopped.current = true
    // A run stopped while a question is up would otherwise hang on the promise.
    settle('')
    if (session.current) {
      stopAgent(session.current)
      session.current = ''
    }
  }, [settle])

  const run = useCallback(async (
    url: string,
    parts: readonly string[],
    /** Percentage of the model's longest side under which a part is left alone. */
    minPartSize: number,
    /** Parts to analyse whatever the floor says about them, by index. */
    keep: readonly number[],
    onNamed: (names: Record<string, string>, details: Record<string, PartDetails>) => void,
  ) => {
    setError(null)
    setReport(null)
    setSubject('')
    setBusy(true)
    setNote('Measuring the model')
    setDone(0)
    setTotal(parts.length)
    stopped.current = false

    // Loaded on demand: it pulls in three.js and a glTF loader, which the
    // Convert tab has no use for and should not be made to download.
    const { openStudio } = await import('./partShots')
    const studio = await openStudio(url)
    if (!studio) {
      setBusy(false)
      setError('This model has no separate parts to name.')
      return
    }

    // Every name the agent has given, by part, so a collision between two
    // unrelated components is still numbered the way the plain namer does it.
    const given = new Map<number, string>()
    const told: Record<string, PartDetails> = {}
    const shaky = new Map<number, AgentNamed>()

    const apply = (named: AgentNamed[]) => {
      if (!named.length) return
      for (const part of named) {
        const original = parts[part.index]
        if (original === undefined) continue
        given.set(part.index, part.name)
        if (part.details && Object.keys(part.details).length) {
          told[original] = part.details
        }
        if (part.confidence === 'low') shaky.set(part.index, part)
        else shaky.delete(part.index)
      }
      onNamed(numbered(given, parts), { ...told })
    }

    try {
      if (studio.names.length !== parts.length) {
        throw new Error('The model changed while it was being measured.')
      }
      let reply: AgentStep = await startAgent(studio.survey(), minPartSize, keep)
      session.current = reply.session

      while (!reply.finished && !stopped.current) {
        setPhase(reply.phase)
        setNote(reply.note)
        if (reply.subject) setSubject(reply.subject)

        const seen: { key: string; image: string }[] = []
        for (const spec of reply.shoot) {
          seen.push({ key: spec.key, image: studio.take(spec) })
          await breathe()
          if (stopped.current) return
        }

        let said = ''
        if (reply.ask) {
          const shown = seen.find((s) => s.key === reply.ask!.image_key)?.image ?? ''
          setNote(reply.note)
          said = await new Promise<string>((resolve) => {
            waiting.current = resolve
            setAsking({ ask: reply.ask!, image: shown })
          })
          if (stopped.current) return
        }

        reply = await stepAgent(session.current, seen, said)
        apply(reply.named)
        setDone(reply.done)
        setTotal(reply.total || parts.length)
      }

      if (!stopped.current) {
        setPhase('done')
        setNote(reply.note)
        setSubject(reply.subject)
        setReport({
          subject: reply.subject,
          summary: reply.summary,
          unsure: [...shaky.values()]
            .sort((a, b) => a.index - b.index)
            .map((p) => ({ index: p.index, name: p.name, evidence: p.evidence })),
        })
      }
    } catch (e) {
      setError((e as Error).message)
    } finally {
      studio.close()
      if (session.current) {
        stopAgent(session.current)
        session.current = ''
      }
      settle('')
      setBusy(false)
      setPhase('')
      setNote('')
    }
  }, [settle])

  return {
    busy, note, phase, subject, done, total, error, setError,
    asking, answer, report, setReport, run, stop,
  }
}
