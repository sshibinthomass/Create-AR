"""FastAPI surface for the converter."""

from __future__ import annotations

import json
import re
import subprocess
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, ValidationError

from . import config, formats
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
_SAFE_STEM = re.compile(r"[^A-Za-z0-9._-]+")


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
        import shutil
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
