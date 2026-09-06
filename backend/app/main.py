"""FastAPI surface for the converter."""

from __future__ import annotations

import json
import math
import re
import shutil
import subprocess
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, ValidationError, field_validator

from . import config, formats, naming, parts_doc
from . import settings as settings_store
from .jobs import new_job_dir, store

config.ensure_dirs()

app = FastAPI(title="3D Model Converter", version="1.0.0")

# The Vite dev server runs on a different origin during development. 5180 is
# this project's default; 5173 is Vite's, kept for a manually started server.
app.add_middleware(
    CORSMiddleware,
    allow_origins=[f"http://{host}:{port}"
                   for host in ("localhost", "127.0.0.1")
                   for port in (5180, 5173)],
    allow_methods=["*"],
    allow_headers=["*"],
)

CHUNK = 1024 * 1024
MAX_RENAMES = 500
MAX_EDITS = 500
MAX_NAME_LEN = 120
_SAFE_STEM = re.compile(r"[^A-Za-z0-9._-]+")

# Material presets, by the name the Analysis tab sends. The viewer keeps a
# matching table so the preview and the exported file agree; see MATERIALS in
# frontend/src/api.ts and in blender_job.py.
MATERIAL_TYPES = ("plastic", "metal", "glass", "matte", "emissive")
_MATERIAL_PATTERN = "^(|" + "|".join(MATERIAL_TYPES) + ")$"
# A move of a thousand times the model's own size is already meaningless, and
# the cap keeps a malformed slider from writing a part out at 1e30.
MOVE_LIMIT = 1e6
SCALE_LIMIT = 1000.0


def _vec3(value: list[float], limit: float) -> list[float]:
    if len(value) != 3:
        raise ValueError("expected three numbers")
    out = []
    for raw in value:
        number = float(raw)
        if not math.isfinite(number):
            raise ValueError("expected a finite number")
        out.append(max(-limit, min(limit, number)))
    return out


class PartEdit(BaseModel):
    """One part's transform and material override, from the Analysis tab.

    Every field is a *delta* on the part's own local transform, in the viewer's
    glTF-style Y-up axes -- the space the user was dragging in. The backend
    swizzles them onto Blender's axes, so rotation and scale pivot on the part's
    origin exactly as they did on screen.
    """

    move: list[float] = Field(default_factory=lambda: [0.0, 0.0, 0.0])
    rotate: list[float] = Field(default_factory=lambda: [0.0, 0.0, 0.0])  # degrees
    scale: list[float] = Field(default_factory=lambda: [1.0, 1.0, 1.0])
    # "" keeps whatever material the part was authored with.
    material: str = Field("", pattern=_MATERIAL_PATTERN)
    color: str = Field("#cccccc", pattern="^#[0-9a-fA-F]{6}$")

    @field_validator("move")
    @classmethod
    def _clean_move(cls, value: list[float]) -> list[float]:
        return _vec3(value, MOVE_LIMIT)

    @field_validator("rotate")
    @classmethod
    def _clean_rotate(cls, value: list[float]) -> list[float]:
        return _vec3(value, 360.0)

    @field_validator("scale")
    @classmethod
    def _clean_scale(cls, value: list[float]) -> list[float]:
        axes = _vec3(value, SCALE_LIMIT)
        if any(a <= 0 for a in axes):
            raise ValueError("scale must be positive on every axis")
        return axes

    def is_noop(self) -> bool:
        return (
            not self.material
            and not any(self.move)
            and not any(self.rotate)
            and all(a == 1.0 for a in self.scale)
        )


class Options(BaseModel):
    """Conversion knobs. Defaults are the identity transform."""

    scale: float = Field(1.0, gt=0, le=10_000)
    center: str = Field("none", pattern="^(none|origin|floor)$")
    apply_modifiers: bool = True
    triangulate: bool = False
    decimate: float = Field(1.0, gt=0.0, le=1.0)
    animations: bool = True
    draco: bool = False
    draco_level: int = Field(6, ge=0, le=10)
    y_up: bool = True
    ascii: bool = False
    cad_tolerance: float = Field(0.01, gt=0, le=10)
    cad_angular_tolerance: float = Field(0.5, gt=0, le=5)
    # Path inside an uploaded archive, when the auto-picked model is not wanted.
    archive_entry: str = Field("", max_length=512)
    # Old object name -> new object name, applied between import and export.
    renames: dict[str, str] = Field(default_factory=dict)
    # Object name -> the tweaks to apply to it, likewise before export.
    edits: dict[str, PartEdit] = Field(default_factory=dict)
    # Write parts.json beside the model and zip the two together. What goes in
    # it comes from the browser, which is where the parts were named.
    bundle: bool = False
    part_details: list[parts_doc.PartDetail] = Field(default_factory=list)

    @field_validator("part_details")
    @classmethod
    def _cap_part_details(cls, value: list) -> list:
        if len(value) > parts_doc.MAX_PARTS:
            raise ValueError(f"at most {parts_doc.MAX_PARTS} described parts per job")
        return value

    @field_validator("renames")
    @classmethod
    def _clean_renames(cls, value: dict[str, str]) -> dict[str, str]:
        if len(value) > MAX_RENAMES:
            raise ValueError(f"at most {MAX_RENAMES} renames per job")
        cleaned: dict[str, str] = {}
        for old, new in value.items():
            # Collapse whitespace and drop control characters: these names end
            # up in glTF nodes, USD prims and OBJ groups.
            name = " ".join(str(new).split())[:MAX_NAME_LEN]
            name = "".join(ch for ch in name if ch.isprintable())
            if name and name != old:
                cleaned[str(old)[:MAX_NAME_LEN]] = name
        return cleaned

    @field_validator("edits")
    @classmethod
    def _drop_untouched_edits(cls, value: dict[str, PartEdit]) -> dict[str, PartEdit]:
        if len(value) > MAX_EDITS:
            raise ValueError(f"at most {MAX_EDITS} edited parts per job")
        # A part the user selected and then left alone carries a full default
        # edit; sending it would make the job look changed when it is not.
        return {str(k)[:MAX_NAME_LEN]: v for k, v in value.items() if not v.is_noop()}


def safe_stem(filename: str) -> str:
    """Strip any directory component and unsafe characters from an upload name."""
    base = Path(filename.replace("\\", "/")).name
    stem = Path(base).stem
    cleaned = _SAFE_STEM.sub("_", stem).strip("._-")
    return cleaned[:80] or "model"


@app.get("/api/health")
def health() -> dict:
    blender = config.find_blender()
    version = None
    if blender:
        try:
            out = subprocess.run([blender, "--version"], capture_output=True,
                                 text=True, timeout=30).stdout
            version = out.strip().splitlines()[0] if out.strip() else None
        except Exception:
            version = None
    try:
        import cascadio  # noqa: F401
        cad = True
    except ImportError:
        cad = False
    return {
        "ok": bool(blender),
        "blenderPath": blender,
        "blenderVersion": version,
        "cadSupport": cad,
        "maxUploadBytes": config.MAX_UPLOAD_BYTES,
    }


@app.get("/api/formats")
def get_formats() -> dict:
    return formats.describe()


@app.get("/api/settings")
def read_settings() -> dict:
    return settings_store.load().public()


@app.put("/api/settings")
def write_settings(incoming: settings_store.Settings, clear_key: str = "") -> dict:
    """Save the settings page.

    The browser is never sent an API key, so it cannot send one back: an empty
    key field means "leave the stored one alone", for each provider separately.
    Forgetting a key is therefore a deliberate act -- `?clear_key=anthropic` --
    rather than something an ordinary save can do by accident.
    """
    if clear_key and clear_key not in settings_store.KEY_FIELDS:
        raise HTTPException(400, f"'{clear_key}' is not a provider.")
    stored = settings_store.load()
    for provider, field in settings_store.KEY_FIELDS.items():
        if not getattr(incoming, field) and provider != clear_key:
            setattr(incoming, field, getattr(stored, field))
    settings_store.save(incoming)
    return incoming.public()


@app.post("/api/name-parts")
def name_parts(request: naming.NameRequest) -> dict:
    """Name one chunk of rendered parts. See naming.py for why it is a chunk."""
    settings = settings_store.load()
    if not settings.configured():
        raise HTTPException(
            400,
            f"The {settings.provider} provider is not set up yet -- open "
            "Settings and fill in what it needs.",
        )
    try:
        named = naming.name_parts(request, settings)
    except naming.NamingError as exc:
        raise HTTPException(502, str(exc)) from exc
    return {"names": [{"index": i, **found} for i, found in named.items()]}


@app.post("/api/convert")
async def create_conversion(
    file: UploadFile = File(...),
    target: str = Form(...),
    options: str = Form("{}"),
) -> JSONResponse:
    target_ext = formats.canonical(target)
    if not formats.is_supported_output(target_ext):
        raise HTTPException(400, f"'{target}' is not a supported output format.")

    source_ext = formats.canonical(Path(file.filename or "").suffix)
    if not formats.is_supported_input(source_ext):
        raise HTTPException(
            400,
            f"'{source_ext or file.filename}' is not a supported input format. "
            f"Accepted: {', '.join(formats.input_exts())}",
        )

    try:
        opts = Options(**json.loads(options or "{}"))
    except (json.JSONDecodeError, ValidationError) as exc:
        raise HTTPException(400, f"Invalid options: {exc}") from exc

    job_id, source_dir = new_job_dir()
    stem = safe_stem(file.filename or "model")
    # Keep the *original* extension so the pipeline can dispatch on it.
    original_ext = Path(file.filename or "").suffix.lower() or source_ext
    dest = source_dir / f"{stem}{original_ext}"

    written = 0
    try:
        with dest.open("wb") as fh:
            while chunk := await file.read(CHUNK):
                written += len(chunk)
                if written > config.MAX_UPLOAD_BYTES:
                    raise HTTPException(
                        413,
                        f"File exceeds the {config.MAX_UPLOAD_BYTES // (1024 * 1024)} MB limit.",
                    )
                fh.write(chunk)
    except HTTPException:
        shutil.rmtree(config.JOBS_DIR / job_id, ignore_errors=True)
        raise

    if written == 0:
        raise HTTPException(400, "The uploaded file was empty.")

    job = store.submit(dest, file.filename or dest.name, target_ext, opts.model_dump())
    return JSONResponse(job.public(), status_code=202)


@app.get("/api/jobs")
def list_jobs() -> dict:
    return {"jobs": [j.public() for j in store.recent()]}


@app.get("/api/jobs/{job_id}")
def get_job(job_id: str) -> dict:
    job = store.get(job_id)
    if job is None:
        raise HTTPException(404, "Job not found or expired.")
    return job.public()


@app.post("/api/jobs/{job_id}/reexport")
def reexport(job_id: str, target: str = Form(...), options: str = Form("{}")) -> JSONResponse:
    """Convert a finished job's *original* upload again, with new options.

    Renaming parts and saving to another format would otherwise mean uploading
    the same model a second time, which for a large assembly is the slowest part
    of the whole exchange. The source is copied into the new job so the two are
    independent: either one can be swept by the TTL without hurting the other.
    """
    job = store.get(job_id)
    if job is None:
        raise HTTPException(404, "Job not found or expired.")

    target_ext = formats.canonical(target)
    if not formats.is_supported_output(target_ext):
        raise HTTPException(400, f"'{target}' is not a supported output format.")

    try:
        opts = Options(**json.loads(options or "{}"))
    except (json.JSONDecodeError, ValidationError) as exc:
        raise HTTPException(400, f"Invalid options: {exc}") from exc

    sources = sorted(p for p in (config.JOBS_DIR / job_id / "source").glob("*") if p.is_file())
    if not sources:
        raise HTTPException(410, "The original upload is no longer available.")

    _, source_dir = new_job_dir()
    dest = source_dir / sources[0].name
    shutil.copyfile(sources[0], dest)

    new_job = store.submit(dest, job.filename, target_ext, opts.model_dump())
    return JSONResponse(new_job.public(), status_code=202)


@app.get("/api/jobs/{job_id}/download")
def download(job_id: str) -> FileResponse:
    job = store.get(job_id)
    if job is None:
        raise HTTPException(404, "Job not found or expired.")
    if job.status != "done":
        raise HTTPException(409, f"Job is {job.status}, not ready for download.")
    result = store.result(job_id)
    if result is None or not result.output_path.exists():
        raise HTTPException(410, "Result file is no longer available.")

    fmt = formats.BY_EXT.get(job.target_ext)
    media = "application/zip" if result.output_path.suffix == ".zip" else (
        fmt.mime if fmt else "application/octet-stream")
    return FileResponse(result.output_path, media_type=media,
                        filename=result.download_name)


@app.get("/api/jobs/{job_id}/preview")
def preview(job_id: str) -> FileResponse:
    job = store.get(job_id)
    if job is None:
        raise HTTPException(404, "Job not found or expired.")
    path = job.preview_path()
    if not path.exists():
        raise HTTPException(404, "No preview available for this job.")
    return FileResponse(path, media_type="model/gltf-binary")


# Serve the built SPA when it exists, so `uvicorn app.main:app` is the whole app.
_dist = config.REPO_DIR / "frontend" / "dist"
if _dist.is_dir():
    app.mount("/", StaticFiles(directory=str(_dist), html=True), name="spa")
