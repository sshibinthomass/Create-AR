"""Archive input: unpack anything, then find the model inside.

Model bundles are distributed as archives because the model alone is useless --
an OBJ needs its .mtl, a glTF needs its .bin and textures. Unpacking keeps those
beside the model so relative references resolve, which is why a zipped OBJ
converts *with* its materials while a bare .obj does not.

Nothing here assumes a layout. Models are located wherever they happen to sit,
nested archives are opened recursively while no model has turned up yet, and the
container format is detected from its magic bytes rather than its extension.
"""

from __future__ import annotations

import tarfile
import zipfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Iterator

from . import formats

MAX_ENTRIES = 4000
MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024  # 2 GiB uncompressed, across all levels
MAX_DEPTH = 4                              # archives inside archives inside...
MAX_NESTED_PER_LEVEL = 8

# Preference when an archive holds several models: self-contained and richer
# formats first, geometry-only and CAD last.
_PRIORITY = [
    ".glb", ".gltf", ".fbx", ".obj", ".blend",
    ".usdz", ".usdc", ".usda", ".usd", ".abc",
    ".stl", ".ply", ".step", ".iges",
]

_JUNK_DIRS = {"__MACOSX"}

# Containers we can open. Detection is by content; extensions lie.
ZIP, TAR, SEVENZIP = "zip", "tar", "7z"

_MAGIC: tuple[tuple[bytes, str], ...] = (
    (b"PK\x03\x04", ZIP),
    (b"PK\x05\x06", ZIP),      # empty archive
    (b"PK\x07\x08", ZIP),      # spanned
    (b"7z\xbc\xaf\x27\x1c", SEVENZIP),
    (b"\x1f\x8b", TAR),        # gzip, assumed to wrap a tar
    (b"BZh", TAR),             # bzip2
    (b"\xfd7zXZ\x00", TAR),    # xz
)

# Recognised but unsupported, so the message can be specific.
_UNSUPPORTED_MAGIC: tuple[tuple[bytes, str], ...] = (
    (b"Rar!\x1a\x07", "RAR"),
    (b"\x1aE\xdf\xa3", "Matroska"),
)


class ArchiveError(RuntimeError):
    """Raised with a message safe to show the user."""


@dataclass
class ArchiveResult:
    model: Path                              # the file to convert
    candidates: list[Path] = field(default_factory=list)   # every model found, best first
    notes: list[str] = field(default_factory=list)


# --- detection ---------------------------------------------------------------

def sniff(path: Path) -> str | None:
    """Identify the container from its leading bytes, or None if not an archive."""
    try:
        with path.open("rb") as fh:
            head = fh.read(512)
    except OSError:
        return None

    for magic, kind in _MAGIC:
        if head.startswith(magic):
            return kind
    for magic, label in _UNSUPPORTED_MAGIC:
        if head.startswith(magic):
            raise ArchiveError(
                f"{label} archives are not supported. Please re-pack as .zip, .tar.gz or .7z."
            )
    # Uncompressed tar carries its magic at offset 257.
    if len(head) > 262 and head[257:262] in (b"ustar", b"ustar".ljust(5)):
        return TAR
    return None


def is_archive(path: Path) -> bool:
    try:
        return sniff(path) is not None
    except ArchiveError:
        return True  # recognised container we cannot open; caller reports it


# --- member iteration --------------------------------------------------------

@dataclass
class Member:
    name: str
    size: int
    is_link: bool
    read: Callable[[], bytes | None]


def _zip_members(path: Path) -> Iterator[Member]:
    with zipfile.ZipFile(path) as zf:
        for info in zf.infolist():
            if info.is_dir():
                continue
            # Unix mode is in the top 16 bits; 0xA000 is S_IFLNK.
            link = (info.external_attr >> 16) & 0xF000 == 0xA000
            yield Member(info.filename, info.file_size, link,
                         lambda i=info: zf.read(i))


def _tar_members(path: Path) -> Iterator[Member]:
    with tarfile.open(path, "r:*") as tf:
        for info in tf:
            if not info.isfile():
                # Links, devices, fifos: never materialised.
                yield Member(info.name, 0, True, lambda: None)
                continue
            yield Member(info.name, info.size, False,
                         lambda i=info: (lambda f: f.read() if f else None)(tf.extractfile(i)))


_READERS = {ZIP: _zip_members, TAR: _tar_members}


def _extract_sevenzip(path: Path, dest: Path, budget: int) -> int:
    """7z has no per-member streaming API, so validate the manifest first.

    Every name is checked against the same traversal rules as the other formats
    before a single byte is written, and the declared sizes are checked against
    the budget; only then is the archive expanded.
    """
    try:
        import py7zr
    except ImportError as exc:
        raise ArchiveError("7z archives need the 'py7zr' package.") from exc

    with py7zr.SevenZipFile(path, "r") as zf:
        if zf.needs_password():
            raise ArchiveError("That 7z archive is password-protected.")
        entries = [i for i in zf.list()
                   if not i.is_directory and not _is_junk(i.filename)]
        if len(entries) > MAX_ENTRIES:
            raise ArchiveError(
                f"That archive has over {MAX_ENTRIES:,} entries; refusing to continue."
            )
        for info in entries:
            if info.is_symlink:
                raise ArchiveError(f"Archive contains a symlink entry: {info.filename}")
            _safe_target(info.filename, dest)  # raises on traversal

        declared = sum(i.uncompressed or 0 for i in entries)
        if declared > budget:
            raise ArchiveError(
                f"That archive expands past the {MAX_TOTAL_BYTES / 1e9:.1f} GB limit."
            )
        zf.extractall(path=str(dest))

    return sum(p.stat().st_size for p in dest.rglob("*") if p.is_file())


# --- extraction --------------------------------------------------------------

def _is_junk(name: str) -> bool:
    parts = Path(name).parts
    return any(p in _JUNK_DIRS for p in parts) or Path(name).name.startswith("._")


def _safe_target(name: str, dest: Path) -> Path:
    """Resolve an archive member name inside ``dest``, or refuse.

    Refuses rather than sanitises: an absolute path or a ``..`` component in a
    distributed model bundle is a red flag, and quietly rewriting it would hide
    that from whoever uploaded it.
    """
    normalised = name.replace("\\", "/")
    candidate = Path(normalised)
    if (normalised.startswith("/") or candidate.is_absolute()
            or candidate.drive or ".." in candidate.parts):
        raise ArchiveError(f"Archive entry escapes the extraction folder: {name}")
    target = (dest / candidate).resolve()
    if not target.is_relative_to(dest):
        raise ArchiveError(f"Archive entry escapes the extraction folder: {name}")
    return target


def safe_extract(archive: Path, dest: Path, budget: int = MAX_TOTAL_BYTES) -> int:
    """Unpack ``archive`` into ``dest``, refusing anything hostile.

    Guards against path traversal (absolute paths, ``..``, drive letters,
    backslash separators), symlink and device entries, entry-count floods and
    decompression bombs. Returns the uncompressed bytes written.
    """
    kind = sniff(archive)
    if kind is None:
        raise ArchiveError("That file is not an archive we can open.")

    dest = dest.resolve()
    dest.mkdir(parents=True, exist_ok=True)
    written = 0
    count = 0

    if kind == SEVENZIP:
        return _extract_sevenzip(archive, dest, budget)

    try:
        members = _READERS[kind](archive)
        for member in members:
            if _is_junk(member.name):
                continue
            if member.is_link:
                continue  # never materialise links out of the sandbox

            count += 1
            if count > MAX_ENTRIES:
                raise ArchiveError(
                    f"That archive has over {MAX_ENTRIES:,} entries; refusing to continue."
                )

            target = _safe_target(member.name, dest)
            data = member.read()
            if data is None:
                continue

            written += len(data)
            if written > budget:
                raise ArchiveError(
                    f"That archive expands past the {MAX_TOTAL_BYTES / 1e9:.1f} GB limit."
                )

            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
    except ArchiveError:
        raise
    except (zipfile.BadZipFile, tarfile.TarError) as exc:
        raise ArchiveError(f"That archive is corrupt or unreadable: {exc}") from exc
    except Exception as exc:  # a malformed container can fail in library-specific ways
        raise ArchiveError(f"Could not read that archive: {type(exc).__name__}: {exc}") from exc

    return written


# --- discovery ---------------------------------------------------------------

def _rank(path: Path, root: Path) -> tuple:
    """Sort key: preferred format, then shallowest, then largest."""
    ext = formats.canonical(path.suffix)
    try:
        priority = _PRIORITY.index(ext)
    except ValueError:
        priority = len(_PRIORITY)
    try:
        depth = len(path.relative_to(root).parts)
        size = path.stat().st_size
    except (ValueError, OSError):
        depth, size = 99, 0
    return (priority, depth, -size)


def find_models(root: Path) -> list[Path]:
    """Every supported model under ``root``, best candidate first."""
    found = [
        p for p in root.rglob("*")
        if p.is_file()
        and not _is_junk(str(p.relative_to(root)))
        and formats.is_supported_input(p.suffix)
        and formats.canonical(p.suffix) not in formats.ARCHIVE_EXTS
    ]
    return sorted(found, key=lambda p: _rank(p, root))


def _nested_archives(root: Path) -> list[Path]:
    """Archives inside the tree, excluding model formats that happen to be zips.

    USDZ is a zip container, so it must never be mistaken for something to
    recurse into -- it is a model in its own right.
    """
    out = []
    for p in sorted(root.rglob("*")):
        if not p.is_file() or _is_junk(str(p)):
            continue
        if formats.is_supported_input(p.suffix) and \
                formats.canonical(p.suffix) not in formats.ARCHIVE_EXTS:
            continue  # a model, not a container
        if p.stat().st_size == 0:
            continue
        try:
            if sniff(p) is None:
                continue
        except ArchiveError:
            continue  # recognised but unsupported; skipped quietly here
        out.append(p)
    # A 'source' folder is the conventional home for the original model.
    return sorted(out, key=lambda p: (
        0 if "source" in {q.lower() for q in p.parent.parts} else 1, -p.stat().st_size))


def extract_model(archive: Path, workdir: Path,
                  prefer: str | None = None) -> ArchiveResult:
    """Unpack ``archive`` and decide which model inside to convert.

    Nested archives are opened recursively while nothing has been found yet, so
    a model wrapped several containers deep is still reached. ``prefer`` is a
    path relative to the extraction root, letting a caller override the pick.
    """
    root = workdir / "archive"
    notes: list[str] = []

    used = safe_extract(archive, root)
    notes.append(f"Unpacked {archive.name}: {used:,} bytes")

    models = find_models(root)
    seen: set[Path] = set()
    depth = 0

    # Only descend while nothing has surfaced: if the archive already offers a
    # model there is no reason to spend time unpacking its extras.
    while not models and depth < MAX_DEPTH:
        depth += 1
        pending = [p for p in _nested_archives(root) if p not in seen][:MAX_NESTED_PER_LEVEL]
        if not pending:
            break
        for inner in pending:
            seen.add(inner)
            target = inner.parent / f"{inner.stem}_unpacked"
            try:
                used += safe_extract(inner, target, budget=MAX_TOTAL_BYTES - used)
            except ArchiveError as exc:
                notes.append(f"Skipped {inner.name}: {exc}")
                continue
            notes.append(f"Unpacked nested {inner.name} (depth {depth})")
        models = find_models(root)

    if not models:
        listing = sorted({p.suffix.lower() for p in root.rglob("*") if p.is_file()})
        raise ArchiveError(
            "No convertible model was found in that archive"
            + (f" (it contains: {', '.join(x for x in listing if x)[:120]})" if listing else "")
            + ". Supported: "
            + ", ".join(e for e in formats.input_exts() if e not in formats.ARCHIVE_EXTS)
        )

    chosen = models[0]
    if prefer:
        wanted = prefer.replace("\\", "/").strip("/")
        match = next(
            (p for p in models if p.relative_to(root).as_posix() == wanted),
            None,
        )
        if match is None:
            raise ArchiveError(
                f"'{prefer}' is not one of the models in that archive. "
                f"Found: {', '.join(p.relative_to(root).as_posix() for p in models[:8])}"
            )
        chosen = match
        notes.append(f"Using {wanted} (chosen explicitly)")
    else:
        notes.append(f"Using {chosen.relative_to(root).as_posix()}")

    if len(models) > 1:
        others = ", ".join(p.relative_to(root).as_posix() for p in models[1:8])
        notes.append(f"Archive also contains: {others}")

    return ArchiveResult(model=chosen, candidates=models, notes=notes)
