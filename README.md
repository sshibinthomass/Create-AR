# Create-AR — 3D Model Converter

Upload a 3D model, pick a target format, get it back converted — with a live 3D
preview of the result in the browser.

Conversion is done by a **headless Blender** process on the machine running the
backend. CAD formats (STEP/IGES) are tessellated with **OpenCASCADE** first,
because Blender has no CAD kernel of its own. Archives are unpacked and the
model inside is found automatically, so a zipped OBJ arrives with its materials
intact.

This is the `Convert` stage of the larger Create-AR Studio pipeline.

![React](https://img.shields.io/badge/React-18-61dafb)
![FastAPI](https://img.shields.io/badge/FastAPI-0.141-009688)
![Blender](https://img.shields.io/badge/Blender-5.2_LTS-f5792a)
![Tests](https://img.shields.io/badge/tests-56_passing-3ecf8e)

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
| `GET` | `/api/jobs/{id}/download` | The converted file (or a zip). |
| `GET` | `/api/jobs/{id}/preview` | GLB used by the in-browser viewer. |

```bash
curl -F file=@part.stp -F target=.usdz \
     -F 'options={"center":"floor","scale":0.001}' \
     http://localhost:8080/api/convert
```

Conversion options: `scale`, `center` (`none`/`origin`/`floor`), `decimate`,
`triangulate`, `apply_modifiers`, `animations`, `draco` (GLB), `y_up`
(USD/USDZ), `cad_tolerance` (STEP/IGES), and `archive_entry` to pick a specific
model inside an archive.

## Sample models

[`samples/`](samples/) holds one file per supported input format — an animated,
two-material Suzanne for the mesh formats and a real 60 × 40 × 8 mm CAD bracket
for STEP/IGES. Drag any of them onto the upload area.

## Tests

```bash
.venv/Scripts/python -m pytest backend/tests -q
```

56 tests: format and alias resolution, upload validation, filename
sanitisation, archive extraction safety (zip-slip, symlinks, entry floods,
decompression bombs), model discovery across container formats and nesting
depths, texture relinking, and real Blender conversions — STL to every headline
target, STEP → USDZ, zipped OBJ with materials, USDZ archive spec compliance,
and scale/centre correctness. Conversion tests skip automatically when Blender
is absent.

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
  App.tsx          upload → format → options → result flow
  components/      Dropzone, OptionsPanel, ModelViewer (three.js)
docs/FORMATS.md    what each engine actually provides, and why
```
