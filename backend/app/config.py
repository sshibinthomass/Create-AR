"""Runtime configuration and Blender discovery."""

from __future__ import annotations

import glob
import os
import shutil
import subprocess
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parent.parent
REPO_DIR = BACKEND_DIR.parent

# Where uploads and results live. Overridable so deployments can point at a volume.
DATA_DIR = Path(os.environ.get("CONVERTER_DATA_DIR", BACKEND_DIR / "data")).resolve()
JOBS_DIR = DATA_DIR / "jobs"

BLENDER_SCRIPT = Path(__file__).resolve().parent / "blender_job.py"

MAX_UPLOAD_BYTES = int(os.environ.get("CONVERTER_MAX_UPLOAD_MB", "512")) * 1024 * 1024
JOB_TIMEOUT_SEC = int(os.environ.get("CONVERTER_JOB_TIMEOUT", "600"))
MAX_WORKERS = int(os.environ.get("CONVERTER_WORKERS", "2"))
JOB_TTL_SEC = int(os.environ.get("CONVERTER_JOB_TTL", str(24 * 3600)))

# Newest first -- prefer the most recent Blender when several are installed.
_WINDOWS_GLOBS = [
    r"C:\Program Files\Blender Foundation\Blender *\blender.exe",
    r"C:\Program Files (x86)\Blender Foundation\Blender *\blender.exe",
    r"C:\Program Files\Blender\blender.exe",
]
_POSIX_CANDIDATES = [
    "/Applications/Blender.app/Contents/MacOS/Blender",
    "/usr/bin/blender",
    "/usr/local/bin/blender",
    "/snap/bin/blender",
]


def _version_key(path: str) -> tuple:
    """Sort key from the version in a Blender install path (e.g. 'Blender 5.2')."""
    import re

    nums = re.findall(r"(\d+)\.(\d+)", path)
    return tuple(int(n) for n in nums[-1]) if nums else (0, 0)


def _candidates() -> list[str]:
    """Every plausible Blender path, best first.

    Real installs are tried *before* anything on PATH: on Windows the
    ``WindowsApps`` entry is a Store alias that shells out to the detached GUI
    launcher, which never proxies stdout and so is useless for headless runs.
    """
    found: list[str] = []
    explicit = os.environ.get("BLENDER_PATH")
    if explicit:
        found.append(explicit)

    if os.name == "nt":
        hits: list[str] = []
        for pattern in _WINDOWS_GLOBS:
            hits.extend(glob.glob(pattern))
        # A Microsoft Store install still ships a usable blender.exe.
        hits.extend(glob.glob(
            r"C:\Program Files\WindowsApps\*Blender*\Blender\blender.exe"))
        found.extend(sorted(hits, key=_version_key, reverse=True))
    else:
        found.extend(c for c in _POSIX_CANDIDATES if Path(c).exists())

    on_path = shutil.which("blender")
    if on_path:
        found.append(on_path)

    seen: set[str] = set()
    return [p for p in found if p and not (p in seen or seen.add(p))]


def _is_usable(path: str) -> bool:
    """A candidate counts only if it answers ``--version`` on stdout."""
    if not Path(path).exists():
        return False
    try:
        out = subprocess.run([path, "--version"], capture_output=True, text=True,
                             timeout=30)
    except (OSError, subprocess.SubprocessError):
        return False
    return "blender" in (out.stdout or "").lower()


_cached: str | None = None
_probed = False


def find_blender(refresh: bool = False) -> str | None:
    """Locate a *working* headless Blender executable. Result is cached."""
    global _cached, _probed
    if _probed and not refresh:
        return _cached
    _cached = next((p for p in _candidates() if _is_usable(p)), None)
    _probed = True
    return _cached


def ensure_dirs() -> None:
    JOBS_DIR.mkdir(parents=True, exist_ok=True)
