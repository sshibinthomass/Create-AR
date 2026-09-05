# Create-AR — 3D Model Converter

Upload a 3D model, pick a target format, get it back converted — with a live 3D
preview of the result in the browser. Conversion is done by a **headless Blender**
process on the machine running the backend; CAD formats (STEP/IGES) are tessellated
with **OpenCASCADE** first, because Blender has no CAD kernel.

This is the `Convert` stage of the larger [Create-AR Studio plan](PLAN.md).

![stack](https://img.shields.io/badge/React-18-61dafb) ![stack](https://img.shields.io/badge/FastAPI-informational) ![stack](https://img.shields.io/badge/Blender-5.2_LTS-orange)

---

## Formats

|                    | Input | Output | Engine |
|--------------------|:-----:|:------:|--------|
| **GLB** / glTF     |  ✅   |   ✅   | Blender |
| **USDZ**, USDC, USDA, USD | ✅ | ✅ | Blender |
| **FBX**            |  ✅   |   ✅   | Blender |
| **OBJ**            |  ✅   |   ✅   | Blender |
| STL                |  ✅   |   ✅   | Blender |
| PLY                |  ✅   |   ✅   | Blender |
| Alembic (`.abc`)   |  ✅   |   ✅   | Blender |
| `.blend`           |  ✅   |   —    | Blender |
| **STEP** (`.step`, `.stp`) | ✅ | — | OpenCASCADE → Blender |
| **IGES** (`.iges`, `.igs`) | ✅ | — | OpenCASCADE → Blender |
| **ZIP** archive | ✅ | — | unpacked, then as above |

CAD is **input-only**: the pipeline tessellates B-rep surfaces into meshes, and
there is no path back from a mesh to parametric CAD.

> **Collada (`.dae`) is not supported.** Blender removed its Collada importer and
> exporter in the 5.x series, so there is no operator to drive. See
> [docs/FORMATS.md](docs/FORMATS.md).

Multi-file outputs (`.obj` → `.obj`+`.mtl`+textures, `.gltf` → `.gltf`+`.bin`+textures)
are returned as a `.zip`.

## Zip archives

Upload the `.zip` a model marketplace gave you and the model inside is found
automatically. This is usually **better** than uploading the model on its own,
because an OBJ needs its `.mtl` and a glTF needs its `.bin` and textures —
extracting keeps them together so those references resolve.

Both common layouts work:

```
scene.gltf + scene.bin + textures/      model at the top level
source/Thing.zip + textures/            real source inside a nested archive
```

When several models are present the most capable one wins (glTF/GLB, then FBX,
then OBJ, …), preferring shallower paths. The download is named after the model
found inside, not the archive.

**Broken texture paths are repaired.** Distributed archives very often ship an
`.mtl` full of the original author's absolute paths (`map_Kd
C:/Users/bob/albedo.png`) while the images sit in a sibling `textures/` folder.
Any texture whose recorded path does not exist is rebound to a file of the *same
filename* elsewhere in the upload, and the job log says how many were relinked.
Matching is by exact filename only, so a wrong image is never substituted — a
texture referenced as `.jpeg` when the archive ships `.png` stays unresolved.

Extraction refuses path traversal (`../`, absolute paths, drive letters),
symlinks, more than 4,000 entries, and anything expanding past 2 GB.

## Sample models

[`samples/`](samples/) holds one file per supported input format — a materialled,
animated Suzanne for the mesh formats and a real 60 × 40 × 8 mm CAD bracket for
STEP/IGES. Drag any of them onto the upload area. See
[samples/README.md](samples/README.md).

## Requirements

- **Blender 4.2+** (developed against 5.2 LTS). Found automatically in the standard
  install locations, or set `BLENDER_PATH` to `blender.exe`.
- **Python 3.11+**
- **Node 20.19+ / 22.12+**

Discovery deliberately skips the Windows `WindowsApps\blender.CMD` alias: it shells
out to the detached GUI launcher, which never returns output to a headless caller.

## Quick start

```bash
git clone <this repo> && cd Create-AR
```

Backend:

```bash
python -m venv .venv && .venv/Scripts/activate    # Linux/macOS: source .venv/bin/activate
pip install -e "backend[dev]"
python -m uvicorn app.main:app --app-dir backend --port 8080 --reload
```

Frontend (second terminal):

```bash
cd frontend && npm install && npm run dev
```

Open <http://localhost:5180>. The dev server proxies `/api` to port 8080.

On Windows both halves can be started at once:

```bash
powershell -ExecutionPolicy Bypass -File dev.ps1
```

### Single-process deployment

Build the frontend and the backend serves it directly — no second server:

```bash
cd frontend && npm run build && cd ..
python -m uvicorn app.main:app --app-dir backend --port 8080
```

Then open <http://localhost:8080>.

### Ports

Both defaults are moved off the conventional ones, which collide with almost
every other project: **8080** for the API (not 8000) and **5180** for the dev
server (not Vite's 5173).

| Port | Override |
|---|---|
| API `8080` | `--port`, and `CONVERTER_PORT` so the Vite proxy follows |
| UI `5180` | `CONVERTER_UI_PORT` |

With `dev.ps1`, pass both as flags — it refuses to start on a busy port rather
than drifting silently to another one:

```bash
powershell -ExecutionPolicy Bypass -File dev.ps1 -Port 9000 -UiPort 5200
```

> Use `http://localhost:<port>`, not `http://127.0.0.1:<port>` — Vite binds to
> the `localhost` hostname, which on Windows does not always answer on the
> IPv4 loopback address.

## Conversion options

| Option | Applies to | Notes |
|---|---|---|
| Scale | all | Uniform multiplier on root objects. |
| Recentre | all | Bounding-box centre, or drop onto the floor (`Z=0`) — useful for AR placement. |
| Simplify | all | Decimate modifier ratio. |
| Triangulate | all | Forces triangles for engines that need them. |
| Apply modifiers | all | Bake the modifier stack into the exported mesh. |
| Keep animations | glTF, FBX, USD | |
| Draco compression | GLB | Much smaller files for web delivery. |
| Y-up | USD/USDZ | On by default — ARKit and Quick Look require Y-up; Blender authors Z-up. |
| CAD tessellation | STEP, IGES | Linear deflection tolerance. Lower = finer mesh, more triangles, slower. |

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `BLENDER_PATH` | auto-detected | Explicit path to the Blender executable. |
| `CONVERTER_DATA_DIR` | `backend/data` | Where uploads and results are written. |
| `CONVERTER_MAX_UPLOAD_MB` | `512` | Upload size limit. |
| `CONVERTER_JOB_TIMEOUT` | `600` | Seconds before a Blender run is killed. |
| `CONVERTER_WORKERS` | `2` | Concurrent Blender processes. |
| `CONVERTER_JOB_TTL` | `86400` | Seconds before finished jobs and their files are swept. |

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

## Tests

```bash
.venv/Scripts/python -m pytest backend/tests -q
```

42 tests, covering format/alias resolution, upload validation, filename
sanitisation, archive extraction safety (zip-slip, symlinks, entry floods,
decompression bombs), model selection inside archives, texture relinking, and
real Blender conversions: STL → GLB/USDZ/FBX/OBJ, STEP → USDZ, zipped OBJ with
materials, USDZ archive compliance, scale/centre correctness, and error
reporting. The conversion tests skip automatically when Blender is absent.

## How it works

```
upload ──▶ [STEP/IGES?] ──▶ OpenCASCADE tessellation ──▶ .glb
                │                                          │
                └────────────── native mesh ───────────────┤
                                                           ▼
                                    headless Blender (import → transform → export)
                                                           │
                                          ┌────────────────┴────────────────┐
                                          ▼                                 ▼
                                   target format                      preview.glb
                                   (zipped if multi-file)          (three.js viewer)
```

The Blender step runs as a subprocess against
[`backend/app/blender_job.py`](backend/app/blender_job.py), which reports progress
back over stdout as `@@`-prefixed JSON lines. Jobs are held in memory and executed
on a small thread pool — this is a single-node service bound to a local Blender
install, so a broker would add operational weight without buying anything.

## Project layout

```
backend/app/
  blender_job.py   runs INSIDE Blender: the import/export operator tables
  converter.py     pipeline: CAD tessellation, subprocess, output packaging
  formats.py       single source of truth for supported formats
  jobs.py          in-memory job store + worker pool
  main.py          FastAPI routes
frontend/src/
  App.tsx          upload → format → options → result flow
  api.ts           typed client
  components/      Dropzone, OptionsPanel, ModelViewer (three.js)
```
