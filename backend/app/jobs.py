"""In-process job store and worker pool.

Deliberately in-memory: this is a single-node desktop-style service bound to a
local Blender install, so a broker (Celery/Redis) would add operational weight
without buying anything. Jobs and their files are dropped after JOB_TTL_SEC.
"""

from __future__ import annotations

import shutil
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path

from . import config
from .converter import ConversionError, Result, convert

MAX_LOG_LINES = 400


@dataclass
class Job:
    id: str
    filename: str
    source_ext: str
    target_ext: str
    options: dict
    status: str = "queued"          # queued | running | done | error
    progress: int = 0
    step: str = "Queued"
    log: list[str] = field(default_factory=list)
    error: str | None = None
    warnings: list[str] = field(default_factory=list)
    created_at: float = field(default_factory=time.time)
    finished_at: float | None = None
    download_name: str | None = None
    output_size: int | None = None
    source_stats: dict | None = None
    result_stats: dict | None = None
    archive_entries: list[str] = field(default_factory=list)
    archive_entry: str | None = None
    # Present when the upload was a bundle this app had written.
    part_doc: dict | None = None

    def public(self) -> dict:
        return {
            "id": self.id,
            "filename": self.filename,
            "sourceExt": self.source_ext,
            "targetExt": self.target_ext,
            "status": self.status,
            "progress": self.progress,
            "step": self.step,
            "error": self.error,
            "warnings": self.warnings,
            "createdAt": self.created_at,
            "finishedAt": self.finished_at,
            "downloadName": self.download_name,
            "outputSize": self.output_size,
            "sourceStats": self.source_stats,
            "resultStats": self.result_stats,
            "archiveEntries": self.archive_entries,
            "archiveEntry": self.archive_entry,
            "partDoc": self.part_doc,
            "hasPreview": self.status == "done" and self.preview_path().exists(),
            "log": self.log[-MAX_LOG_LINES:],
        }

    def dir(self) -> Path:
        return config.JOBS_DIR / self.id

    def preview_path(self) -> Path:
        return self.dir() / "preview.glb"


class JobStore:
    def __init__(self) -> None:
        self._jobs: dict[str, Job] = {}
        self._results: dict[str, Result] = {}
        self._lock = threading.Lock()
        self._pool = ThreadPoolExecutor(max_workers=config.MAX_WORKERS,
                                        thread_name_prefix="convert")

    # --- accessors ---
    def get(self, job_id: str) -> Job | None:
        with self._lock:
            return self._jobs.get(job_id)

    def result(self, job_id: str) -> Result | None:
        with self._lock:
            return self._results.get(job_id)

    def recent(self, limit: int = 25) -> list[Job]:
        with self._lock:
            jobs = sorted(self._jobs.values(), key=lambda j: j.created_at, reverse=True)
        return jobs[:limit]

    # --- mutation helpers (each takes the lock briefly) ---
    def _set(self, job_id: str, **fields) -> None:
        with self._lock:
            job = self._jobs.get(job_id)
            if job is None:
                return
            for key, value in fields.items():
                setattr(job, key, value)

    def _append_log(self, job_id: str, line: str) -> None:
        with self._lock:
            job = self._jobs.get(job_id)
            if job is None:
                return
            job.log.append(line)
            if len(job.log) > MAX_LOG_LINES * 2:
                del job.log[:-MAX_LOG_LINES]

    # --- lifecycle ---
    def submit(self, source: Path, filename: str, target_ext: str, options: dict) -> Job:
        job_id = source.parent.parent.name
        job = Job(
            id=job_id,
            filename=filename,
            source_ext=Path(filename).suffix.lower(),
            target_ext=target_ext,
            options=options,
        )
        with self._lock:
            self._jobs[job_id] = job
        self._pool.submit(self._run, job_id, source, target_ext, options)
        self.sweep()
        return job

    def _run(self, job_id: str, source: Path, target_ext: str, options: dict) -> None:
        job = self.get(job_id)
        if job is None:
            return
        self._set(job_id, status="running", step="Starting", progress=2)
        try:
            result = convert(
                job_dir=job.dir(),
                source=source,
                target_ext=target_ext,
                options=options,
                on_progress=lambda pct, step: self._set(job_id, progress=pct, step=step),
                on_log=lambda line: self._append_log(job_id, line),
            )
        except ConversionError as exc:
            self._set(job_id, status="error", error=str(exc), step="Failed",
                      finished_at=time.time())
            return
        except Exception as exc:  # unexpected: log the type so it is debuggable
            self._append_log(job_id, f"{type(exc).__name__}: {exc}")
            self._set(job_id, status="error", error="Unexpected server error during conversion.",
                      step="Failed", finished_at=time.time())
            return

        with self._lock:
            self._results[job_id] = result
        self._set(
            job_id,
            status="done",
            progress=100,
            step="Done",
            finished_at=time.time(),
            download_name=result.download_name,
            output_size=result.output_path.stat().st_size,
            source_stats=result.source_stats,
            result_stats=result.result_stats,
            warnings=result.warnings,
            archive_entries=result.archive_entries,
            archive_entry=result.archive_entry,
            part_doc=result.part_doc,
        )

    def sweep(self) -> int:
        """Drop jobs (and their files) past the TTL. Returns how many went."""
        cutoff = time.time() - config.JOB_TTL_SEC
        with self._lock:
            stale = [j.id for j in self._jobs.values()
                     if j.created_at < cutoff and j.status in {"done", "error"}]
            for job_id in stale:
                self._jobs.pop(job_id, None)
                self._results.pop(job_id, None)
        for job_id in stale:
            shutil.rmtree(config.JOBS_DIR / job_id, ignore_errors=True)
        return len(stale)


def new_job_dir() -> tuple[str, Path]:
    """Allocate an id and its ``source/`` directory before the upload streams in."""
    job_id = uuid.uuid4().hex[:16]
    source_dir = config.JOBS_DIR / job_id / "source"
    source_dir.mkdir(parents=True, exist_ok=True)
    return job_id, source_dir


store = JobStore()
