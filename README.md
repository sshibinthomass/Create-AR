# Create-AR — 3D Model Converter

Upload a 3D model, pick a target format, get it back converted — with a live 3D
preview of the result in the browser, and an Analysis tab that pulls a model
apart into an exploded view, names every part, and saves it back out with the
names you gave them.

Conversion is done by a **headless Blender** process on the machine running the
backend. CAD formats (STEP/IGES) are tessellated with **OpenCASCADE** first,
because Blender has no CAD kernel of its own. Archives are unpacked and the
model inside is found automatically, so a zipped OBJ arrives with its materials
intact.

This is the `Convert` stage of the larger Create-AR Studio pipeline.

![React](https://img.shields.io/badge/React-18-61dafb)
![FastAPI](https://img.shields.io/badge/FastAPI-0.141-009688)
![Blender](https://img.shields.io/badge/Blender-5.2_LTS-f5792a)
![Tests](https://img.shields.io/badge/tests-60_passing-3ecf8e)

---

## Formats

|  | Input | Output | Engine |
|---|:--:|:--:|---|
| **GLB** / glTF | ✅ | ✅ | Blender |
| **USDZ**, USDC, USDA, USD | ✅ | ✅ | Blender |
| **FBX** | ✅ | ✅ | Blender |
| **OBJ** | ✅ | ✅ | Blender |
| STL | ✅ | ✅ | Blender |
| PLY | ✅ | ✅ | Blender |
| Alembic (`.abc`) | ✅ | ✅ | Blender |
| `.blend` | ✅ | — | Blender |
| **STEP** (`.step`, `.stp`) | ✅ | — | OpenCASCADE → Blender |
| **IGES** (`.iges`, `.igs`) | ✅ | — | OpenCASCADE → Blender |
| **Archives** — `.zip`, `.7z`, `.tar(.gz/.bz2/.xz)` | ✅ | — | unpacked, then as above |

CAD and archives are **input-only** — there is no path back from a mesh to
parametric CAD, and the output is a model rather than a bundle.

> **Collada (`.dae`) is not supported.** Blender removed its Collada importer
> and exporter in the 5.x series, so there is no operator to drive.
> [`docs/FORMATS.md`](docs/FORMATS.md) records what each engine actually
> provides, verified by introspection rather than read from documentation.

## How it works

```
upload ──▶ [archive?] ──▶ unpack, locate model ──┐
                                                 │
           [STEP/IGES?] ──▶ OpenCASCADE ──▶ .glb ─┤
                                                 ▼
                    headless Blender (import → transform → export)
                                                 │
                              ┌──────────────────┴──────────────────┐
                              ▼                                     ▼
                       target format                          preview.glb
                    (zipped if multi-file)                  (three.js viewer)
```

The Blender step runs as a subprocess against
[`backend/app/blender_job.py`](backend/app/blender_job.py), which reports
progress back over stdout as `@@`-prefixed JSON lines. Jobs are held in memory
and executed on a small thread pool.

Three details that matter in practice:

- **USD/USDZ is exported Y-up.** ARKit and Quick Look require it; Blender
  authors Z-up. Getting this wrong is the usual reason a model lies on its side
  in AR.
- **Broken texture paths are repaired.** Marketplace bundles routinely ship an
  `.mtl` full of the author's own absolute paths (`map_Kd C:/Users/bob/x.png`)
  while the images sit in a sibling `textures/` folder. Missing images are
  rebound by *exact filename*, so a wrong texture is never substituted.
- **Archive layout is not assumed.** The container is identified by magic bytes
  rather than extension, the model is found anywhere in the tree, and nested
  archives are opened recursively — including mixed `.zip` → `.tar.gz` → `.zip`
  chains. Every candidate is reported and the pick can be overridden.

---

## Exploded view and part names

Any preview can be taken apart. **Separate parts** in the top-right corner of
the viewer opens a slider that moves every part outward from the centre of the
assembly, proportionally to how far off-centre it already sits — so the
arrangement stays recognisable instead of flying into an even starburst. Closing
the panel puts the model back together.

The **Analysis** tab is built around that view. Loading a model spans the top of
the tab; underneath, the parts and the editor take the left and the viewer takes
the right, which is the half you work in. Drop a model in and it goes straight
to the exploded viewer, with every part listed beside it. Click a
part — in the viewer or in the list — and that one is named on the model and
outlined, with its row scrolled into view; click the background to drop the
selection. Only the selected part is labelled, because a real assembly has
hundreds of parts and naming them all at once buries the model (there is a
checkbox for it anyway, for small models). Edit a name in the list and the
label follows it. Pick a format, press **Save as**, and the model is written out
with the new names. Anything the converter can read works, so an FBX, a STEP
assembly or a zipped OBJ can all be taken apart and relabelled.

Saving does not re-upload: the server still has the model from the analysis
pass, so only the names travel. Names are applied to the Blender objects between
import and export, which is what glTF nodes, USD prims, FBX objects and OBJ
groups are all written from. **STL and PLY store a single unnamed mesh**, so
names cannot survive a save to those; the UI says so before you press the
button. (OBJ has no quoting, so `Top Cover` is written as `Top_Cover`.)

Three details worth knowing:

- **Parts are the ones the model was authored with.** The viewer descends past
  wrapper nodes to the level that actually holds more than one object. A model
  exported as a single merged mesh has no parts to separate, and says so rather
  than pretending otherwise.
- **Parts sitting at the centre still come out.** A core inside a housing has no
  outward direction of its own and would stay buried however far the slider goes,
  so anything nearer the centre than its own size is given a direction from an
  evenly spread set.

- **Names come from the model, not from the viewer.** They are the object names
  the exporter wrote, so what you rename is the thing the next tool downstream
  will show. The outline is drawn without depth testing, so a part selected
  from the list is still visible when it sits inside another one.

Separation is applied in the browser, to the preview GLB, and is only a way of
looking at the model — it never moves anything in the file you download. Edits
made in the panel below the list, on the other hand, do.

## Marking parts

A click marks one part and drops whatever was marked before; **shift-click**
(or ctrl/cmd-click) adds one to the marks or takes it away again, in the viewer
and in the list alike. Clicking the background clears them. Every marked part is
outlined and named, and the count appears above the list.

Marks are what the editor works on, so several parts can be moved, turned,
resized or restyled in one go. A group turns and grows about the middle of the
group rather than each part spinning on its own spot, which is what picking a
set of parts and rotating them is meant to do.

## Editing a part

Marking a part also opens an editor under the list, for changing those parts
rather than the whole model: **move** it along each axis, **rotate** it, **scale**
it per axis, and give it a **material** and a colour. The viewer shows every
change as it is made, and pressing **Save as** writes them into the file along
with the names.

Everything in that panel can also be done by hand in the viewport. With a part
selected, **Move**, **Rotate** and **Scale** in the top-left corner attach a
gizmo to it, the way Blender or Unity would: drag a handle to edit the part,
drag anywhere else to orbit. The sliders and the gizmo are two views of the same
edit and follow each other live. Pressing the active mode again puts the gizmo
away. With several parts marked the gizmo sits at the middle of the group and
moves all of them together.

Orbit, pan and zoom are deliberately slower than three.js's defaults. A wheel
notch at the default speed crosses a good part of the model, which overshoots
constantly on an assembly you are picking single parts out of. **Reset view**,
beside the separation button, puts the camera back where it started when you
have turned yourself around.

The gizmo does not grab the part's own origin. Plenty of exports leave every
origin on the world origin -- a Sketchfab model wraps each part in an identity
node and offsets the geometry inside it -- so handles drawn there would sit
nowhere near the part you clicked, and every part's would sit in the same place.
An empty stands in at the part's visible centre instead, and its motion is
passed on. The handles are also drawn over the model rather than inside it: a
part is usually surrounded by the rest of the assembly, and a depth-tested gizmo
is buried the moment it is anchored on the part it edits.

- **An edit is a delta on the part's own transform**, so rotation and scale pivot
  on its origin and compose with whatever pose it was authored with. The axes are
  the viewer's, and moves are in the model's units. The slider reaches as far as
  the assembly is wide *measured in the space a move is applied in*, which is not
  the same as its size on screen: a model wrapped in a scaled root can be a
  hundredth of a unit across in the world and whole units across in its own.
- **The preview is not an approximation.** Blender's glTF exporter maps a node's
  local transform onto glTF's axes componentwise at any depth, so an edit made on
  screen is swizzled back onto Blender's axes and applied unchanged. What the
  viewer shows is what the saved file contains, to float precision.
- **A material replaces the part's own outright**, textures included. The five
  presets — plastic, metal, glass, matte and glowing — are Principled BSDF
  settings, and the colour you pick is converted from sRGB so the exported file
  is the shade you chose. Leave the type on *Keep original* to move a part
  without touching how it looks.
- **STL and PLY keep neither names nor materials**, but the moves, rotations and
  scales still apply, because those are baked into the geometry that is written.
  OBJ needs every part to carry a material once any part is styled, so unstyled
  ones are given a plain grey; otherwise they would inherit the styled part's
  colour from the file's running `usemtl` state.
- **Part names are the file's own, not the viewer's.** three.js strips `[`, `]`,
  `.`, `:` and `/` out of glTF node names when it loads them, because its
  animation binding syntax reserves those characters. Maya and Sketchfab
  namespace their parts with a colon, so the sanitised name would match nothing
  on the way back; the viewer recovers the original from the loader's own node
  mapping and keys edits and renames by that.
- **A panel showing several parts shows what they agree on.** Any axis they
  differ on reads as none until you set it, and only the fields you actually
  move are written across -- otherwise nudging one slider would flatten every
  other value the parts did not happen to share.
- **An edit that names no part in the model is reported**, not passed over. If a
  save comes back with a warning naming parts, those names no longer match the
  objects the converter found, and nothing was applied to them.

Edits are cleared when a different model is analysed. **Reset** in the editor
returns the marked parts to how they arrived. Above the list, **Reset names**
and **Reset edits** each undo one kind for the whole model and leave the other
alone, so renaming a hundred parts is not lost to undoing a move. Each appears
only when there is something of its kind to undo, and neither touches what you
have marked.

---

## Quick start

### Docker (recommended)

The only supported way to get a known-good Blender without installing one:

```bash
docker build -t create-ar-converter .
```

```bash
docker run -d -p 8080:8080 -v converter-data:/data --name converter create-ar-converter
```

Open <http://localhost:8080>. Nothing else is required — the image contains
Blender, the API and the built frontend.

### Local development

Needs **Blender 4.2+** (developed against 5.2 LTS), **Python 3.11+** and
**Node 20.19+/22.12+**. Blender is found automatically in the standard install
locations, or set `BLENDER_PATH`.

```bash
python -m venv .venv && .venv/Scripts/activate    # Linux/macOS: source .venv/bin/activate
pip install -e "backend[dev]"
```

```bash
cd frontend && npm install && npm run dev
```

```bash
python -m uvicorn app.main:app --app-dir backend --port 8080 --reload
```

Open <http://localhost:5180>; the dev server proxies `/api` to port 8080. On
Windows `dev.ps1` starts both halves at once.

> Ports default to **8080** (API) and **5180** (UI), both moved off the
> conventional 8000/5173 which collide with almost every other project.
> Override with `CONVERTER_PORT` and `CONVERTER_UI_PORT`.
>
> Use `http://localhost:<port>`, not `127.0.0.1` — Vite binds the hostname,
> which on Windows does not always answer on the IPv4 loopback.

---

## Deployment strategy

### The constraint that shapes everything

**This service cannot run without Blender on the same host.** It shells out to a
real Blender binary per job. That rules out serverless and every
"bring-your-own-runtime" PaaS with a small image budget, and it sets the floor
for image size, memory and start-up time. Plan around it rather than against it.

Consequences:

| | |
|---|---|
| Image size | ~2.5 GB, most of it Blender. Not shrinkable in any meaningful way. |
| Cold start | Seconds, not milliseconds. Keep instances warm. |
| Per-job cost | One Blender process, CPU-bound, seconds to minutes. |
| Memory | Blender holds the whole scene. A 450k-triangle model needs ~1–2 GB *per concurrent job*. |
| GPU | Not needed. Conversion is import/export, not rendering. |

### Recommended: single container behind a reverse proxy

The [`Dockerfile`](Dockerfile) builds the SPA, downloads a pinned Blender from
blender.org, and serves everything from one process on port 8080. Blender is
downloaded rather than `apt install`ed deliberately: distro packages lag badly,
and this service depends on operators that only exist in 4.2+.

```yaml
# docker-compose.yml
services:
  converter:
    build: .
    ports: ["8080:8080"]
    volumes: [converter-data:/data]
    environment:
      CONVERTER_WORKERS: "2"
      CONVERTER_MAX_UPLOAD_MB: "512"
      CONVERTER_JOB_TIMEOUT: "900"
      CONVERTER_JOB_TTL: "86400"
    restart: unless-stopped
    deploy:
      resources:
        limits: { cpus: "4", memory: 8G }
volumes:
  converter-data:
```

Put nginx (or your load balancer) in front, and **raise the two limits that
will otherwise bite**:

```nginx
location / {
    proxy_pass http://converter:8080;
    client_max_body_size 512m;   # must be >= CONVERTER_MAX_UPLOAD_MB
    proxy_read_timeout 900s;     # must be >= CONVERTER_JOB_TIMEOUT
    proxy_request_buffering off; # stream large uploads instead of spooling
}
```

The defaults in most proxies are 1 MB and 60 s. Both are far too small here, and
the resulting failures look like application bugs.

### Storage

Uploads, intermediates and results live under `CONVERTER_DATA_DIR` (`/data` in
the image). Mount a volume: without one, results vanish on restart and every
in-flight job is lost.

Finished jobs and their files are swept after `CONVERTER_JOB_TTL` (24 h by
default). Size the volume for peak concurrent jobs plus one TTL window of
results — a single 450k-triangle model produces roughly 30 MB of output, and the
source, the unpacked archive and the preview are all kept alongside it.

### Scaling

The job store is **in-process and in-memory**, and job files are on **local
disk**. That is a deliberate choice for a single-node service bound to a local
Blender install — a broker would add operational weight without buying anything
at this size — but it has a hard consequence:

> **Do not run more than one replica behind a round-robin load balancer.**
> A client that uploads to instance A and polls instance B gets a 404.

To scale vertically, raise `CONVERTER_WORKERS` (concurrent Blender processes)
and give the container proportional CPU and RAM. Two workers on 4 CPUs is a
sensible starting point.

To scale horizontally, three things have to change:

1. Move the job store out of process (Redis or Postgres) — `backend/app/jobs.py`
   is the only file that owns job state.
2. Move job files to shared object storage (S3 or equivalent).
3. Run conversion as a real queue worker rather than a thread pool.

Until then, prefer one larger instance over several small ones. Sticky sessions
are *not* a sufficient workaround, because results are also on that instance's
disk.

### Security posture

The service accepts untrusted archives and hands untrusted files to Blender.
What is already handled:

- Archive extraction **refuses rather than sanitises**: path traversal (`../`,
  absolute paths, drive letters, backslash separators), symlink and device
  entries, >4,000 entries, >2 GB expansion, and encrypted archives.
- Upload size is capped (`CONVERTER_MAX_UPLOAD_MB`) and enforced while
  streaming, not after.
- Filenames are sanitised to a safe stem; the original never touches the
  filesystem path.
- Every Blender run is `--factory-startup`, killed after
  `CONVERTER_JOB_TIMEOUT`, and the container runs as a non-root user.

What is **not** handled, and should be before exposing this publicly:

- **No authentication or rate limiting.** Anyone who can reach it can spend your
  CPU. Put it behind your own auth, or on a private network.
- **Blender parses untrusted files in-process.** It is not a sandbox. For hostile
  input, isolate the container further (seccomp, read-only root, no network,
  dropped capabilities).

### Configuration

| Variable | Default | Meaning |
|---|---|---|
| `BLENDER_PATH` | auto-detected | Explicit path to the Blender executable. |
| `CONVERTER_DATA_DIR` | `backend/data` | Where uploads and results are written. |
| `CONVERTER_MAX_UPLOAD_MB` | `512` | Upload size limit. |
| `CONVERTER_JOB_TIMEOUT` | `600` | Seconds before a Blender run is killed. |
| `CONVERTER_WORKERS` | `2` | Concurrent Blender processes. |
| `CONVERTER_JOB_TTL` | `86400` | Seconds before finished jobs and files are swept. |

Discovery deliberately skips the Windows `WindowsApps\blender.CMD` alias: it
shells out to the detached GUI launcher, which never returns output to a
headless caller. Candidates are validated by running `--version`.

### Health checks

`GET /api/health` returns `ok: false` when Blender is missing and
`cadSupport: false` when OpenCASCADE is unavailable. Use it as both the
readiness and liveness probe — a container whose Blender is broken should not
receive traffic.

```json
{"ok": true, "blenderPath": "/opt/blender/blender",
 "blenderVersion": "Blender 5.2.1 LTS", "cadSupport": true,
 "maxUploadBytes": 536870912}
```

---

## API

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/health` | Blender path/version, CAD availability, upload limit. |
| `GET` | `/api/formats` | Capability matrix that drives the UI. |
| `POST` | `/api/convert` | multipart: `file`, `target`, `options` → `202` + job. |
| `GET` | `/api/jobs/{id}` | Status, progress, stats, log. |
| `POST` | `/api/jobs/{id}/reexport` | Convert the same upload again: `target`, `options`. |
| `GET` | `/api/jobs/{id}/download` | The converted file (or a zip). |
| `GET` | `/api/jobs/{id}/preview` | GLB used by the in-browser viewer. |

```bash
curl -F file=@part.stp -F target=.usdz \
     -F 'options={"center":"floor","scale":0.001}' \
     http://localhost:8080/api/convert
```

Conversion options: `scale`, `center` (`none`/`origin`/`floor`), `decimate`,
`triangulate`, `apply_modifiers`, `animations`, `draco` (GLB), `y_up`
(USD/USDZ), `cad_tolerance` (STEP/IGES), `archive_entry` to pick a specific
model inside an archive, `renames` — a `{"old": "new"}` map of part names — and
`edits`, a map of part name to `{"move": [x, y, z], "rotate": [x, y, z], "scale":
[x, y, z], "material": "metal", "color": "#ff2200"}`. Both are applied between
import and export. Every edit field is a delta on the part's own local transform
in the viewer's glTF-style Y-up axes, not Blender's Z-up; rotations are in
degrees and scale is a multiplier per axis.

## Sample models

[`samples/`](samples/) holds one file per supported input format — an animated,
two-material Suzanne for the mesh formats and a real 60 × 40 × 8 mm CAD bracket
for STEP/IGES. Drag any of them onto the upload area.

## Tests

```bash
.venv/Scripts/python -m pytest backend/tests -q
```

60 tests: format and alias resolution, upload validation, filename
sanitisation, archive extraction safety (zip-slip, symlinks, entry floods,
decompression bombs), model discovery across container formats and nesting
depths, texture relinking, and real Blender conversions — STL to every headline
target, STEP → USDZ, zipped OBJ with materials, USDZ archive spec compliance,
scale/centre correctness, and part renaming through a re-export. Conversion
tests skip automatically when Blender is absent.

## Project layout

```
backend/app/
  blender_job.py   runs INSIDE Blender: the import/export operator tables
  archives.py      unpacking, extraction safety, model discovery
  converter.py     pipeline: CAD tessellation, subprocess, output packaging
  formats.py       single source of truth for supported formats
  jobs.py          in-memory job store + worker pool
  main.py          FastAPI routes
frontend/src/
  App.tsx          shell: health/capabilities and the two tabs
  useConversion.ts upload + job polling, shared by both tabs
  views/           ConvertView (format → options → result), AnalysisView
  components/      Dropzone, OptionsPanel, ModelViewer (three.js + explode)
docs/FORMATS.md    what each engine actually provides, and why
```
