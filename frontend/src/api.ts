export interface Format {
  ext: string
  label: string
  category: 'mesh' | 'cad' | 'scene' | 'archive'
  engine: 'blender' | 'opencascade' | 'archive'
  can_import: boolean
  can_export: boolean
  mime: string
  note: string
  /** Whether a file of this format can carry the animations made in the Analysis tab. */
  can_animate: boolean
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
  images: number
  /** Total texture area. What a resolution cap actually trades away. */
  texturePixels: number
}

/**
 * What a part is, beyond its name.
 *
 * The labels are the model's own choice, not a fixed schema: what is worth
 * saying about a bearing is not what is worth saying about a wiring loom. Both
 * the viewer and the exported document just walk whatever came back.
 */
export type PartDetails = Record<string, string>

export interface PartsDocEntry {
  index: number
  originalName: string
  name: string
  details: PartDetails
}

/** The parts.json written beside a model, and read back out of a bundle. */
export interface PartsDoc {
  format: string
  version: number
  generatedAt: string
  model: { file?: string; sourceFile?: string; parts?: number }
  parts: PartsDocEntry[]
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
  /** The upload's size on disk, for comparing against `outputSize`. */
  sourceSize: number | null
  sourceStats: Stats | null
  resultStats: Stats | null
  archiveEntries: string[]
  archiveEntry: string | null
  /** Present when the upload was a bundle this app had written. */
  partDoc: PartsDoc | null
  hasPreview: boolean
  log: string[]
}

/** '' keeps whatever material the part was authored with. */
export type MaterialType = '' | 'plastic' | 'metal' | 'glass' | 'matte' | 'emissive'

/**
 * Where a part is put, as a *delta* on its own local transform.
 *
 * In the viewer's axes and the model's units -- the same thing a gizmo drag
 * produces. The backend swizzles them onto Blender's axes, so rotation and
 * scale pivot on the part's origin exactly as they did on screen. An edit is
 * one of these held still; a keyframe is one of these at a moment in time.
 */
export interface Pose {
  move: [number, number, number]
  rotate: [number, number, number]  // degrees, about the part's own axes
  scale: [number, number, number]
}

/**
 * How a part travels *out* of a keyframe, towards the next one.
 *
 * Three, because an assembly study needs three: parts that slide at a constant
 * rate, parts that pull away and settle the way a hand would move them, and
 * parts that sit still until a moment and then are simply elsewhere.
 */
export type Ease = 'linear' | 'smooth' | 'hold'

/** A pose a part passes through, `time` seconds into its clip. */
export interface Keyframe extends Pose {
  time: number
  /** Absent means `linear` -- what every clip made before easing existed did. */
  ease?: Ease
}

/** The target of a track that moves the whole model rather than one part. */
export const WHOLE = ''

/**
 * Every keyframe one target has in a clip, in time order.
 *
 * The target is a part, by the name the file gives it, or `WHOLE` for the
 * model as one -- which turns and grows about `pivot`, the centre the viewer
 * measured, and which the backend is told so the file pivots where the
 * preview did.
 */
export interface Track {
  target: string
  keys: Keyframe[]
  pivot?: [number, number, number]
}

/** One named animation: how long it runs, and the tracks that play in it. */
export interface Clip {
  /** Only the browser's: tells two clips of the same name apart in the list. */
  id: string
  name: string
  duration: number  // seconds
  tracks: Track[]
}

/** A small tweak to one part, made in the Analysis tab: a pose held still, and a finish. */
export interface PartEdit extends Pose {
  material: MaterialType
  color: string                     // '#rrggbb'
  /**
   * Whether `color` is applied when no preset is chosen.
   *
   * A preset always paints in `color`, so this means nothing to one. Without a
   * preset it is the difference between "leave the part as the file shades it"
   * and "leave it, but in this colour" -- picking a part out of an assembly by
   * eye without pretending it is made of something else. Where the part is
   * textured the colour tints the texture rather than replacing it, which is
   * what the exporter does too.
   */
  recolor: boolean
  /**
   * How solid the part is. 1 is the part as the file has it.
   *
   * The one styling that does not need a preset: seeing through a housing is
   * worth doing *without* throwing away the finish you are looking through, so
   * with no preset chosen the part keeps its own materials and only fades.
   */
  opacity: number
  /**
   * Where the chosen preset is nudged to. Both are seeded from the preset the
   * moment one is picked, and mean nothing without one -- there is no telling
   * what the file's own shading was, so there is no value that means "leave it".
   */
  roughness: number
  metalness: number
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
  recolor: false,
  opacity: 1,
  roughness: MATERIALS.plastic.roughness, metalness: MATERIALS.plastic.metalness,
}

/** Whether an edit changes how the part is shaded, as opposed to where it sits. */
export const isRestyled = (e: PartEdit | undefined): boolean =>
  e != null && (e.material !== '' || e.opacity < 1 || e.recolor)

export const isEdited = (e: PartEdit | undefined): boolean =>
  e != null && (isRestyled(e)
    || e.move.some((v) => v !== 0) || e.rotate.some((v) => v !== 0)
    || e.scale.some((v) => v !== 1))

/** Which gizmo, if any, is attached to the selected part in the viewer. */
export type GizmoMode = 'translate' | 'rotate' | 'scale' | null

/** How the triangle reduction is aimed: a flat percentage, or a total to hit. */
export type ReduceMode = 'percent' | 'budget'

/** `auto` keeps each image in the format it was authored in. */
export type TextureFormat = 'auto' | 'jpeg' | 'webp'

/** How meshes are joined together. `material` keeps one mesh per material. */
export type MergeMode = 'none' | 'material' | 'all'

export interface ConvertOptions {
  scale: number
  center: 'none' | 'origin' | 'floor'
  apply_modifiers: boolean
  triangulate: boolean
  decimate: number
  /**
   * A total triangle count to aim for. 0 leaves `decimate` in charge.
   *
   * Meshes at or under 64 triangles are left alone and the rest share one
   * ratio, so the reduction comes out of the parts that actually hold the
   * triangles instead of flattening every small bolt equally.
   */
  tri_budget: number
  /** Longest edge a texture may keep, in pixels. 0 leaves images alone. */
  texture_limit: number
  texture_format: TextureFormat
  texture_quality: number
  merge: MergeMode
  /** Merge-by-distance threshold, in model units. 0 is off. */
  weld: number
  /** Drop unused material slots and loose geometry. */
  clean: boolean
  animations: boolean
  draco: boolean
  draco_level: number
  y_up: boolean
  cad_tolerance: number
  /** Path inside an archive, when the auto-picked model is not the wanted one. */
  archive_entry?: string
  /** Old part name -> new part name, written into the exported file. */
  renames?: Record<string, string>
  /** Part name -> the move, rotation, scale and material to apply to it. */
  edits?: Record<string, PartEdit>
  /** Parts to drop from the model entirely, by the name the file gives them. */
  remove?: string[]
  /** Write parts.json beside the model and zip the two together. */
  bundle?: boolean
  part_details?: PartsDocEntry[]
  /** Animations to key into the file. Only formats with `can_animate` take them. */
  clips?: Clip[]
}

/**
 * A finished conversion handed from the Convert tab to the Analysis tab.
 *
 * Carries the job rather than the produced file: the server still holds the
 * original upload, so Analysis re-exports *that* to GLB with the same options
 * instead of pushing a model back up the wire. The result is the model as it
 * was just compressed, which is the one the user is looking at.
 */
export interface Handoff {
  jobId: string
  /** What to show in the Analysis source card. */
  name: string
  options: ConvertOptions
}

export const DEFAULT_OPTIONS: ConvertOptions = {
  scale: 1,
  center: 'none',
  apply_modifiers: true,
  triangulate: false,
  decimate: 1,
  tri_budget: 0,
  texture_limit: 0,
  texture_format: 'auto',
  texture_quality: 85,
  merge: 'none',
  weld: 0,
  clean: false,
  animations: true,
  draco: false,
  draco_level: 6,
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

/**
 * A texture area as megapixels.
 *
 * Raw pixel counts run to eight digits and say nothing to read at a glance;
 * "19.8 MP" against "1.9 MP" is the comparison that matters.
 */
export function formatPixels(n: number | null | undefined): string {
  if (n == null) return '--'
  if (n === 0) return 'none'
  const mp = n / 1_000_000
  if (mp < 0.1) return `${Math.round(n / 1000)} kP`
  return `${mp.toFixed(mp < 10 ? 1 : 0)} MP`
}

/* ---------- part naming ---------- */

/**
 * The naming settings, as the browser sees them.
 *
 * Every API key is deliberately absent: the server never sends one back, only
 * which providers it holds a key for. Saving with a key field empty therefore
 * means "keep the one you have", which is why forgetting a key is its own
 * request.
 */
export type Provider = 'azure' | 'openai' | 'anthropic' | 'compatible'

export interface NamerSettings {
  provider: Provider

  azure_endpoint: string
  azure_deployment: string
  azure_api_version: string

  openai_model: string

  anthropic_model: string

  /** Any endpoint speaking the OpenAI chat-completions API. */
  compatible_url: string
  compatible_model: string

  /** 'single' sends one part per request, 'batch' sends `batch_size` of them. */
  mode: 'single' | 'batch'
  batch_size: number
  /** Requests the browser keeps in flight at once. */
  concurrency: number
  /** Send the second picture: the part highlighted in the whole assembly. */
  context_shot: boolean
  /** Ask what each part is as well as what to call it. */
  describe: boolean
  instructions: string
  describe_instructions: string

  /** Which providers the server is holding a key for. */
  keys: Record<Provider, boolean>
  /** Whether the *selected* provider has everything it needs. */
  configured: boolean
}

export const getSettings = () => fetch('/api/settings').then(json<NamerSettings>)

/**
 * Save the settings.
 *
 * `keys` carries only the providers whose key the user actually typed; the rest
 * are left as the server has them. `forget` names one provider whose stored key
 * should be dropped.
 */
export function saveSettings(
  settings: NamerSettings,
  keys: Partial<Record<Provider, string>>,
  forget?: Provider,
): Promise<NamerSettings> {
  const body = {
    ...settings,
    azure_key: keys.azure ?? '',
    openai_key: keys.openai ?? '',
    anthropic_key: keys.anthropic ?? '',
    compatible_key: keys.compatible ?? '',
  }
  return fetch(`/api/settings?clear_key=${forget ?? ''}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then(json<NamerSettings>)
}

/** One part's renders, on the way to the model. Images are base64 JPEG. */
export interface PartShotPayload {
  index: number
  name: string
  isolated: string
  context: string
}

/**
 * Name one chunk of parts -- a single part, or a batch of them.
 *
 * `taken` is the names already handed out for this model, so the reply can
 * avoid repeating them; with several requests in flight it is a snapshot, and
 * the model is asked to treat it as a hint rather than a rule.
 */
export interface NamedPart {
  index: number
  name: string
  details: PartDetails
}

export function nameParts(
  parts: PartShotPayload[],
  total: number,
  taken: string[],
  describe: boolean,
): Promise<{ names: NamedPart[] }> {
  return fetch('/api/name-parts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ parts, total, taken, describe }),
  }).then(json<{ names: NamedPart[] }>)
}
