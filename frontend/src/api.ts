export interface Format {
  ext: string
  label: string
  category: 'mesh' | 'cad' | 'scene'
  engine: 'blender' | 'opencascade'
  can_import: boolean
  can_export: boolean
  mime: string
  note: string
}

export interface Capabilities {
  formats: Format[]
  aliases: Record<string, string>
  inputs: string[]
  outputs: string[]
}

export interface Health {
  ok: boolean
  blenderPath: string | null
  blenderVersion: string | null
  cadSupport: boolean
  maxUploadBytes: number
}

export interface Stats {
  objects: number
  meshes: number
  materials: number
  vertices: number
  triangles: number
  dimensions: [number, number, number] | null
}

export type JobStatus = 'queued' | 'running' | 'done' | 'error'

export interface Job {
  id: string
  filename: string
  sourceExt: string
  targetExt: string
  status: JobStatus
  progress: number
  step: string
  error: string | null
  warnings: string[]
  createdAt: number
  finishedAt: number | null
  downloadName: string | null
  outputSize: number | null
  sourceStats: Stats | null
  resultStats: Stats | null
  hasPreview: boolean
  log: string[]
}

export interface ConvertOptions {
  scale: number
  center: 'none' | 'origin' | 'floor'
  apply_modifiers: boolean
  triangulate: boolean
  decimate: number
  animations: boolean
  draco: boolean
  y_up: boolean
  cad_tolerance: number
}

export const DEFAULT_OPTIONS: ConvertOptions = {
  scale: 1,
  center: 'none',
  apply_modifiers: true,
  triangulate: false,
  decimate: 1,
  animations: true,
  draco: false,
  y_up: true,
  cad_tolerance: 0.01,
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let detail = `${res.status} ${res.statusText}`
    try {
      const body = await res.json()
      if (body?.detail) detail = typeof body.detail === 'string' ? body.detail : JSON.stringify(body.detail)
    } catch {
      /* keep the status line */
    }
    throw new Error(detail)
  }
  return res.json() as Promise<T>
}

export const getHealth = () => fetch('/api/health').then(json<Health>)
export const getCapabilities = () => fetch('/api/formats').then(json<Capabilities>)
export const getJob = (id: string) => fetch(`/api/jobs/${id}`).then(json<Job>)
export const downloadUrl = (id: string) => `/api/jobs/${id}/download`
export const previewUrl = (id: string) => `/api/jobs/${id}/preview`

export function startConversion(
  file: File,
  target: string,
  options: ConvertOptions,
  onUploadProgress?: (pct: number) => void,
): Promise<Job> {
  const form = new FormData()
  form.append('file', file)
  form.append('target', target)
  form.append('options', JSON.stringify(options))

  // XHR rather than fetch: upload progress events matter for large models.
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', '/api/convert')
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onUploadProgress) {
        onUploadProgress(Math.round((e.loaded / e.total) * 100))
      }
    }
    xhr.onload = () => {
      let body: unknown
      try {
        body = JSON.parse(xhr.responseText)
      } catch {
        reject(new Error(`Unexpected server response (${xhr.status})`))
        return
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(body as Job)
      else reject(new Error((body as { detail?: string })?.detail ?? `Upload failed (${xhr.status})`))
    }
    xhr.onerror = () => reject(new Error('Network error while uploading.'))
    xhr.send(form)
  })
}

export function formatBytes(n: number | null | undefined): string {
  if (n == null) return '--'
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB']
  let value = n / 1024
  let i = 0
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024
    i++
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[i]}`
}

export const formatCount = (n: number | null | undefined): string =>
  n == null ? '--' : n.toLocaleString()
