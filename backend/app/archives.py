"""Zip input: extract safely, then find the model inside.

Model bundles are usually distributed as archives because the model alone is
useless -- an OBJ needs its .mtl, a glTF needs its .bin and textures. Extracting
keeps those beside the model so relative references resolve, which is why a
zipped OBJ converts *with* its materials while a bare .obj does not.

Two layouts are handled, both common on model marketplaces:

    scene.gltf + scene.bin + textures/     model at the top level
    source/Thing.zip + textures/           real source inside a nested archive
"""

from __future__ import annotations

import zipfile
from pathlib import Path

from . import formats

MAX_ENTRIES = 4000
MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024  # 2 GiB uncompressed
MAX_NESTED_ARCHIVES = 4

# Preference when an archive holds several models: self-contained and
# richer formats first, geometry-only and CAD last.
_PRIORITY = [
    ".glb", ".gltf", ".fbx", ".obj", ".blend",
    ".usdz", ".usdc", ".usda", ".usd", ".abc",
    ".stl", ".ply", ".step", ".iges",
]

# macOS resource forks and editor cruft, never the model.
_JUNK_DIRS = {"__MACOSX"}


class ArchiveError(RuntimeError):
    """Raised with a message safe to show the user."""


def _is_junk(name: str) -> bool:
    parts = Path(name).parts
    return any(p in _JUNK_DIRS for p in parts) or Path(name).name.startswith("._")


def _is_symlink(info: zipfile.ZipInfo) -> bool:
    # Unix mode lives in the top 16 bits of external_attr; 0xA000 is S_IFLNK.
    return (info.external_attr >> 16) & 0xF000 == 0xA000


def safe_extract(archive: Path, dest: Path, budget: int = MAX_TOTAL_BYTES) -> int:
    """Extract ``archive`` into ``dest``, refusing anything hostile.

    Guards against zip-slip (absolute paths, ``..`` traversal, drive letters),
    symlink escapes, entry-count floods and decompression bombs. Returns the
    number of uncompressed bytes written.
    """
    try:
        zf = zipfile.ZipFile(archive)
    except zipfile.BadZipFile as exc:
        raise ArchiveError("That .zip file is corrupt or not a zip archive.") from exc

    dest = dest.resolve()
    dest.mkdir(parents=True, exist_ok=True)
    written = 0

    with zf:
        infos = [i for i in zf.infolist() if not _is_junk(i.filename)]
        if len(infos) > MAX_ENTRIES:
            raise ArchiveError(
                f"That archive has {len(infos):,} entries; the limit is {MAX_ENTRIES:,}."
            )

        declared = sum(i.file_size for i in infos)
        if declared > budget:
            raise ArchiveError(
                f"That archive expands to {declared / 1e9:.1f} GB, "
                f"over the {budget / 1e9:.1f} GB limit."
            )

        for info in infos:
            if info.is_dir():
                continue
            if _is_symlink(info):
                continue  # never materialise links out of the sandbox

            name = info.filename.replace("\\", "/")
            candidate = Path(name)
            if candidate.is_absolute() or candidate.drive or ".." in candidate.parts:
                raise ArchiveError(f"Archive entry escapes the extraction folder: {name}")

            target = (dest / candidate).resolve()
            if not target.is_relative_to(dest):
                raise ArchiveError(f"Archive entry escapes the extraction folder: {name}")

            target.parent.mkdir(parents=True, exist_ok=True)
            with zf.open(info) as src, target.open("wb") as out:
                while chunk := src.read(1024 * 1024):
                    written += len(chunk)
                    if written > budget:
                        raise ArchiveError("Archive is larger than declared; refusing to continue.")
                    out.write(chunk)

    return written


def _rank(path: Path, root: Path) -> tuple:
    """Sort key: preferred format, then shallowest, then largest."""
    ext = formats.canonical(path.suffix)
    try:
        priority = _PRIORITY.index(ext)
    except ValueError:
        priority = len(_PRIORITY)
    depth = len(path.relative_to(root).parts)
    try:
        size = path.stat().st_size
    except OSError:
        size = 0
    return (priority, depth, -size)


def find_models(root: Path) -> list[Path]:
    """Every supported model file under ``root``, best candidate first."""
    found = [
        p for p in root.rglob("*")
        if p.is_file()
        and not _is_junk(str(p.relative_to(root)))
        and formats.is_supported_input(p.suffix)
        and formats.canonical(p.suffix) != ".zip"
    ]
    return sorted(found, key=lambda p: _rank(p, root))


def extract_model(archive: Path, workdir: Path) -> tuple[Path, list[str]]:
    """Extract ``archive`` and return the model to convert, plus a short log.

    Falls back to nested archives (the ``source/Thing.zip`` layout) when the
    top level holds no model of its own.
    """
    root = workdir / "archive"
    notes: list[str] = []

    total = safe_extract(archive, root)
    notes.append(f"Extracted {archive.name}: {total:,} bytes")

    models = find_models(root)

    if not models:
        nested = sorted(
            (p for p in root.rglob("*.zip") if p.is_file() and not _is_junk(str(p))),
            # A 'source' folder is the conventional home for the real model.
            key=lambda p: (0 if "source" in {q.lower() for q in p.parent.parts} else 1,
                           -p.stat().st_size),
        )[:MAX_NESTED_ARCHIVES]

        for inner in nested:
            target = inner.parent / (inner.stem + "_extracted")
            try:
                total += safe_extract(inner, target, budget=MAX_TOTAL_BYTES - total)
            except ArchiveError as exc:
                notes.append(f"Skipped nested {inner.name}: {exc}")
                continue
            notes.append(f"Extracted nested {inner.name}")

        models = find_models(root)

    if not models:
        raise ArchiveError(
            "No convertible model was found in that archive. Supported files: "
            + ", ".join(e for e in formats.input_exts() if e != ".zip")
        )

    chosen = models[0]
    if len(models) > 1:
        others = ", ".join(p.name for p in models[1:6])
        notes.append(f"Using {chosen.name}; archive also contains {others}")
    else:
        notes.append(f"Using {chosen.name}")

    return chosen, notes
