"""Conversion pipeline: optional CAD tessellation, then a headless Blender run."""

from __future__ import annotations

import json
import shutil
import subprocess
import zipfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

from . import archives, config, formats
from .archives import ArchiveError

ProgressFn = Callable[[int, str], None]
LogFn = Callable[[str], None]


class ConversionError(RuntimeError):
    """Raised with a message safe to show the user."""


@dataclass
class Result:
    output_path: Path            # the file the user downloads
    download_name: str
    preview_path: Path | None = None
    source_stats: dict | None = None
    result_stats: dict | None = None
    warnings: list[str] = field(default_factory=list)
    archive_entries: list[str] = field(default_factory=list)  # models found inside
    archive_entry: str | None = None                          # the one converted


def tessellate_cad(src: Path, dst: Path, options: dict) -> None:
    """STEP/IGES -> GLB via OpenCASCADE. Blender has no CAD kernel of its own."""
    try:
        import cascadio
    except ImportError as exc:  # pragma: no cover - depends on install
        raise ConversionError(
            "CAD input needs the 'cascadio' package (pip install cascadio)."
        ) from exc

    file_type = "iges" if formats.canonical(src.suffix) == ".iges" else "step"
    tol = float(options.get("cad_tolerance", 0.01))
    try:
        glb = cascadio.load(
            src.read_bytes(),
            file_type=file_type,
            tol_linear=tol,
            tol_angular=float(options.get("cad_angular_tolerance", 0.5)),
            merge_primitives=True,
        )
    except Exception as exc:
        raise ConversionError(f"Could not read the {file_type.upper()} file: {exc}") from exc

    if not glb:
        raise ConversionError(
            f"The {file_type.upper()} file contained no solid geometry to tessellate."
        )
    dst.write_bytes(glb)


def _parse_marker(line: str) -> tuple[str, dict] | None:
    """Decode a ``@@kind {json}`` line emitted by the in-Blender script."""
    if not line.startswith("@@"):
        return None
    body = line[2:]
    kind, _, payload = body.partition(" ")
    try:
        return kind, json.loads(payload) if payload.strip() else {}
    except json.JSONDecodeError:
        return None


def run_blender(cfg_path: Path, on_progress: ProgressFn, on_log: LogFn) -> dict:
    """Run Blender headless, translating its stdout markers into progress."""
    blender = config.find_blender()
    if not blender:
        raise ConversionError(
            "Blender was not found. Install it, or set BLENDER_PATH to blender.exe."
        )

    cmd = [
        blender, "-b", "--factory-startup",
        "--python", str(config.BLENDER_SCRIPT),
        "--", str(cfg_path),
    ]
    collected: dict = {"stats": {}, "warnings": [], "error": None}

    proc = subprocess.Popen(
        cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        text=True, encoding="utf-8", errors="replace", bufsize=1,
    )
    try:
        for raw in proc.stdout:  # type: ignore[union-attr]
            line = raw.rstrip("\r\n")
            if not line:
                continue
            marker = _parse_marker(line)
            if marker is None:
                on_log(line)
                continue
            kind, payload = marker
            if kind == "progress":
                # Blender occupies 15..100 of the job's own progress bar.
                on_progress(int(payload.get("pct", 0)), payload.get("step", ""))
            elif kind == "stats":
                collected["stats"].update(payload)
            elif kind == "info":
                on_log(payload.get("message", ""))
            elif kind == "warn":
                collected["warnings"].append(payload.get("message", ""))
                on_log("warning: " + payload.get("message", ""))
            elif kind == "error":
                collected["error"] = payload.get("message", "unknown error")
                if payload.get("traceback"):
                    on_log(payload["traceback"])
        code = proc.wait(timeout=config.JOB_TIMEOUT_SEC)
    except subprocess.TimeoutExpired as exc:
        proc.kill()
        raise ConversionError(
            f"Conversion timed out after {config.JOB_TIMEOUT_SEC}s."
        ) from exc
    finally:
        if proc.poll() is None:
            proc.kill()

    if code != 0:
        raise ConversionError(collected["error"] or f"Blender exited with code {code}.")
    return collected


def _package_outputs(out_dir: Path, primary: Path, stem: str, target_ext: str) -> tuple[Path, str]:
    """Zip the result when the exporter produced sidecars (.mtl, .bin, textures)."""
    produced = [p for p in out_dir.rglob("*") if p.is_file()]
    if target_ext not in formats.MULTIFILE_EXTS and len(produced) <= 1:
        return primary, primary.name

    archive = out_dir.parent / f"{stem}{target_ext.replace('.', '_')}.zip"
    with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as zf:
        for p in produced:
            zf.write(p, p.relative_to(out_dir).as_posix())
    return archive, archive.name


def convert(
    job_dir: Path,
    source: Path,
    target_ext: str,
    options: dict,
    on_progress: ProgressFn,
    on_log: LogFn,
) -> Result:
    """Convert ``source`` into ``target_ext``, returning what to serve back."""
    src_ext = formats.canonical(source.suffix)
    target_ext = formats.canonical(target_ext)

    if not formats.is_supported_input(src_ext):
        raise ConversionError(f"'{source.suffix}' is not a supported input format.")
    if not formats.is_supported_output(target_ext):
        raise ConversionError(f"'{target_ext}' is not a supported output format.")

    work = job_dir / "work"
    out_dir = job_dir / "out"
    work.mkdir(parents=True, exist_ok=True)
    out_dir.mkdir(parents=True, exist_ok=True)

    stem_override: str | None = None
    texture_root: Path | None = None
    entries: list[str] = []
    entry: str | None = None
    if src_ext in formats.ARCHIVE_EXTS:
        on_progress(4, "Unpacking archive")
        try:
            found = archives.extract_model(
                source, work, prefer=options.get("archive_entry") or None)
        except ArchiveError as exc:
            raise ConversionError(str(exc)) from exc
        for note in found.notes:
            on_log(note)
        root = work / "archive"
        entries = [p.relative_to(root).as_posix() for p in found.candidates]
        entry = found.model.relative_to(root).as_posix()
        source = found.model
        # Name the download after the model inside, not "archive.glb".
        stem_override = source.stem
        texture_root = root
        src_ext = formats.canonical(source.suffix)
        if not formats.is_supported_input(src_ext):
            raise ConversionError(f"'{src_ext}' inside the archive is not a supported input.")

    blender_input = source
    if src_ext in formats.CAD_EXTS:
        on_progress(5, f"Tessellating {src_ext.upper().lstrip('.')} geometry")
        on_log(f"OpenCASCADE: reading {source.name}")
        blender_input = work / "cad.glb"
        tessellate_cad(source, blender_input, options)
        on_log(f"OpenCASCADE: produced {blender_input.stat().st_size} bytes of GLB")

    stem = stem_override or source.stem or "model"
    primary = out_dir / f"{stem}{target_ext}"
    preview = job_dir / "preview.glb"

    cfg = {
        "input": str(blender_input),
        "input_ext": formats.canonical(blender_input.suffix),
        "output": str(primary),
        "output_ext": target_ext,
        "preview": str(preview),
        "texture_root": str(texture_root) if texture_root else None,
        "options": options,
    }
    cfg_path = work / "config.json"
    cfg_path.write_text(json.dumps(cfg, indent=2), encoding="utf-8")

    collected = run_blender(cfg_path, on_progress, on_log)

    if not primary.exists():
        raise ConversionError("Blender finished but produced no output file.")

    if target_ext == ".glb" and not preview.exists():
        shutil.copyfile(primary, preview)

    download_path, download_name = _package_outputs(out_dir, primary, stem, target_ext)
    stats = collected["stats"]
    return Result(
        output_path=download_path,
        download_name=download_name,
        preview_path=preview if preview.exists() else None,
        source_stats=stats.get("source"),
        result_stats=stats.get("result"),
        warnings=collected["warnings"],
        archive_entries=entries,
        archive_entry=entry,
    )
