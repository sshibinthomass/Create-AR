import { useCallback, useEffect, useRef, useState } from 'react'
import { getJob, reexportJob, startConversion, type ConvertOptions, type Job } from './api'

const ACTIVE = new Set(['queued', 'running'])

export const isActive = (job: Job | null) => job != null && ACTIVE.has(job.status)

/**
 * Upload a model, then poll its job until it settles.
 *
 * Shared by both tabs: converting to a chosen format and converting to GLB
 * purely to look at it exploded are the same server-side operation.
 */
export function useConversion(onSettled?: (job: Job) => void) {
  const [job, setJob] = useState<Job | null>(null)
  const [uploadPct, setUploadPct] = useState(0)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Kept in a ref so a caller need not memoise the callback to avoid restarting
  // the poll on every render.
  const settled = useRef(onSettled)
  settled.current = onSettled

  useEffect(() => {
    if (!isActive(job)) return
    const id = job!.id
    const timer = window.setInterval(async () => {
      try {
        const next = await getJob(id)
        setJob(next)
        if (!ACTIVE.has(next.status)) settled.current?.(next)
      } catch {
        /* transient; the next tick retries */
      }
    }, 700)
    return () => window.clearInterval(timer)
  }, [job])

  const start = useCallback(async (file: File, target: string, options: ConvertOptions) => {
    setError(null)
    setUploading(true)
    setUploadPct(0)
    try {
      setJob(await startConversion(file, target, options, setUploadPct))
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setUploading(false)
    }
  }, [])

  /** Same, for a model the server already has: no second upload. */
  const startFrom = useCallback(async (jobId: string, target: string, options: ConvertOptions) => {
    setError(null)
    try {
      setJob(await reexportJob(jobId, target, options))
    } catch (e) {
      setError((e as Error).message)
    }
  }, [])

  return {
    job, setJob, uploading, uploadPct, error, setError, start, startFrom,
    busy: uploading || isActive(job),
  }
}
