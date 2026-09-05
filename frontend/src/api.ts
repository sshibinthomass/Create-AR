export interface Format {
  ext: string
  label: string
  category: 'mesh' | 'cad' | 'scene' | 'archive'
  engine: 'blender' | 'opencascade' | 'archive'
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
  archiveEntries: string[]
  archiveEntry: string | null
  hasPreview: boolean
  log: string[]
}

/** '' keeps whatever material the part was authored with. */
export type MaterialType = '' | 'plastic' | 'metal' | 'glass' | 'matte' | 'emissive'

/**
 * A small tweak to one part, made in the Analysis tab.
 *
 * Every field is a *delta* on the part's own local transform, in the viewer's
 * axes and the model's units -- the same thing a gizmo drag produces. The
 * backend swizzles them onto Blender's axes, so rotation and scale pivot on the
 * part's origin exactly as they did on screen.
 */
export interface PartEdit {
  move: [number, number, number]
  rotate: [number, number, number]  // degrees, about the part's own axes
  scale: [number, number, number]
  material: MaterialType
  color: string                     // '#rrggbb'
}

/** Principled BSDF settings per material, mirroring MATERIALS in blender_job.py. */
export const MATERIALS: Record<Exclude<MaterialType, ''>, {
  label: string
  metalness: number
  roughness: number
  transmission: number
  emission: number
}> = {
  plastic: { label: 'Plastic', metalness: 0, roughness: 0.35, transmission: 0, emission: 0 },
  metal: { label: 'Metal', metalness: 1, roughness: 0.25, transmission: 0, emission: 0 },
  glass: { label: 'Glass', metalness: 0, roughness: 0.05, transmission: 1, emission: 0 },
  matte: { label: 'Matte', metalness: 0, roughness: 0.9, transmission: 0, emission: 0 },
  emissive: { label: 'Glowing', metalness: 0, roughness: 0.5, transmission: 0, emission: 2 },
}

export const NO_EDIT: PartEdit = {
  move: [0, 0, 0], rotate: [0, 0, 0], scale: [1, 1, 1], material: '', color: '#9aa6c0',
}

export const isEdited = (e: PartEdit | undefined): boolean =>
  e != null && (e.material !== ''
    || e.move.some((v) => v !== 0) || e.rotate.some((v) => v !== 0)
    || e.scale.some((v) => v !== 1))

/** Which gizmo, if any, is attached to the selected part in the viewer. */
export type GizmoMode = 'translate' | 'rotate' | 'scale' | null

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
  /** Path inside an archive, when the auto-picked model is not the wanted one. */
  archive_entry?: string
  /** Old part name -> new part name, written into the exported file. */
  renames?: Record<string, string>
  /** Part name -> the move, rotation, scale and material to apply to it. */
  edits?: Record<string, PartEdit>
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

/**
 * Convert a finished job's original upload again, with different options.
 *
 * Used to save renamed parts: the model is already on the server, so there is
 * no reason to push the whole thing back up it.
 */
export function reexportJob(jobId: string, target: string, options: ConvertOptions): Promise<Job> {
  const form = new FormData()
  form.append('target', target)
  form.append('options', JSON.stringify(options))
  return fetch(`/api/jobs/${jobId}/reexport`, { method: 'POST', body: form }).then(json<Job>)
}

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

// Grouped in thousands whatever the reader's locale is. The default grouping
// follows the browser, which renders 453,296 as 4,53,296 in en-IN and similar --
// correct for prose, but these sit in a row of figures meant to be scanned and
// compared against what other 3D tools report.
const COUNT = new Intl.NumberFormat('en-US')

export const formatCount = (n: number | null | undefined): string =>
  n == null ? '--' : COUNT.format(n)
