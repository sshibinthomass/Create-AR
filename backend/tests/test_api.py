"""End-to-end tests. The conversion cases drive a real headless Blender."""

from __future__ import annotations

import io
import json
import os
import time
import zipfile
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

os.environ.setdefault("CONVERTER_DATA_DIR", str(Path(__file__).parent / "_data"))

from app import config, formats  # noqa: E402
from app.main import app, safe_stem  # noqa: E402

FIXTURES = Path(__file__).parent / "fixtures"
CUBE_STL = FIXTURES / "cube.stl"
BOX_STEP = FIXTURES / "box.step"

client = TestClient(app)

needs_blender = pytest.mark.skipif(
    config.find_blender() is None, reason="no Blender installation found"
)


# --- format registry ---------------------------------------------------------

def test_canonical_resolves_aliases_and_case():
    assert formats.canonical(".stp") == ".step"
    assert formats.canonical("STP") == ".step"
    assert formats.canonical(".IGS") == ".iges"
    assert formats.canonical("glb") == ".glb"


def test_cad_and_target_formats_are_advertised():
    body = client.get("/api/formats").json()
    for ext in (".stl", ".step", ".stp", ".iges", ".igs", ".obj", ".fbx", ".glb"):
        assert ext in body["inputs"], ext
    for ext in (".usdz", ".glb", ".fbx", ".obj"):
        assert ext in body["outputs"], ext
    # CAD is input-only: there is no B-rep writer in this pipeline.
    assert ".step" not in body["outputs"]


def test_health_reports_blender():
    body = client.get("/api/health").json()
    assert body["cadSupport"] is True
    if config.find_blender():
        assert body["ok"] is True
        assert "blender" in (body["blenderVersion"] or "").lower()


# --- input validation --------------------------------------------------------

def test_rejects_unsupported_input_extension():
    r = client.post(
        "/api/convert",
        files={"file": ("notes.txt", b"hello", "text/plain")},
        data={"target": ".glb"},
    )
    assert r.status_code == 400
    assert "not a supported input" in r.json()["detail"]


def test_rejects_unsupported_output_extension():
    r = client.post(
        "/api/convert",
        files={"file": ("cube.stl", CUBE_STL.read_bytes(), "model/stl")},
        data={"target": ".dae"},
    )
    assert r.status_code == 400


def test_rejects_empty_upload():
    r = client.post(
        "/api/convert",
        files={"file": ("cube.stl", b"", "model/stl")},
        data={"target": ".glb"},
    )
    assert r.status_code == 400


def test_rejects_invalid_options():
    r = client.post(
        "/api/convert",
        files={"file": ("cube.stl", CUBE_STL.read_bytes(), "model/stl")},
        data={"target": ".glb", "options": json.dumps({"scale": -5})},
    )
    assert r.status_code == 400


@pytest.mark.parametrize("raw,expected", [
    ("../../etc/passwd", "passwd"),
    (r"C:\Users\me\model.stl", "model"),
    ("weird name (1).obj", "weird_name_1"),
    (".stl", "stl"),  # a dotfile has no suffix, so the whole name is the stem
])
def test_safe_stem_strips_paths_and_specials(raw, expected):
    assert safe_stem(raw) == expected


def test_unknown_job_is_404():
    assert client.get("/api/jobs/deadbeef").status_code == 404


# --- conversions -------------------------------------------------------------

def run_job(filename: str, payload: bytes, target: str, options: dict | None = None,
            timeout: float = 240.0) -> dict:
    r = client.post(
        "/api/convert",
        files={"file": (filename, payload, "application/octet-stream")},
        data={"target": target, "options": json.dumps(options or {})},
    )
    assert r.status_code == 202, r.text
    job_id = r.json()["id"]

    deadline = time.time() + timeout
    while time.time() < deadline:
        job = client.get(f"/api/jobs/{job_id}").json()
        if job["status"] in {"done", "error"}:
            return job
        time.sleep(0.4)
    pytest.fail(f"job {job_id} did not finish within {timeout}s")


@needs_blender
@pytest.mark.parametrize("target", [".glb", ".usdz", ".fbx", ".obj"])
def test_stl_converts_to_every_headline_target(target):
    job = run_job("cube.stl", CUBE_STL.read_bytes(), target)
    assert job["status"] == "done", job["error"]
    assert job["resultStats"]["triangles"] == 12
    # Fixture is a 2 x 1 x 3 box; the pipeline must not distort it.
    assert job["resultStats"]["dimensions"] == pytest.approx([2.0, 1.0, 3.0], abs=1e-4)

    dl = client.get(f"/api/jobs/{job['id']}/download")
    assert dl.status_code == 200
    assert len(dl.content) > 0
    # OBJ fans out into .obj + .mtl, so it comes back zipped.
    if target == ".obj":
        assert dl.headers["content-type"] == "application/zip"
        names = zipfile.ZipFile(io.BytesIO(dl.content)).namelist()
        assert any(n.endswith(".obj") for n in names), names


@needs_blender
def test_usdz_output_is_a_spec_compliant_archive():
    job = run_job("cube.stl", CUBE_STL.read_bytes(), ".usdz")
    assert job["status"] == "done", job["error"]
    data = client.get(f"/api/jobs/{job['id']}/download").content
    zf = zipfile.ZipFile(io.BytesIO(data))
    entries = zf.infolist()
    assert entries, "USDZ archive is empty"
    assert any(e.filename.endswith((".usdc", ".usda")) for e in entries)
    # USDZ requires stored (uncompressed) entries.
    assert all(e.compress_type == zipfile.ZIP_STORED for e in entries)


@needs_blender
def test_step_cad_input_converts_to_usdz():
    job = run_job("box.stp", BOX_STEP.read_bytes(), ".usdz")
    assert job["status"] == "done", job["error"]
    assert job["resultStats"]["triangles"] == 12
    assert client.get(f"/api/jobs/{job['id']}/download").status_code == 200


@needs_blender
def test_scale_and_center_options_are_applied():
    job = run_job("cube.stl", CUBE_STL.read_bytes(), ".glb",
                  {"scale": 2.0, "center": "floor"})
    assert job["status"] == "done", job["error"]
    assert job["resultStats"]["dimensions"] == pytest.approx([4.0, 2.0, 6.0], abs=1e-4)


@needs_blender
def test_preview_is_available_for_non_glb_targets():
    job = run_job("cube.stl", CUBE_STL.read_bytes(), ".fbx")
    assert job["status"] == "done", job["error"]
    assert job["hasPreview"] is True
    r = client.get(f"/api/jobs/{job['id']}/preview")
    assert r.status_code == 200
    assert r.content[:4] == b"glTF"


@needs_blender
def test_corrupt_cad_file_fails_with_a_clear_message():
    job = run_job("broken.stp", b"ISO-10303-21;\nnot really a step file\n", ".glb")
    assert job["status"] == "error"
    assert "STEP" in job["error"]


def test_download_before_completion_is_rejected():
    r = client.post(
        "/api/convert",
        files={"file": ("cube.stl", CUBE_STL.read_bytes(), "model/stl")},
        data={"target": ".glb"},
    )
    job_id = r.json()["id"]
    dl = client.get(f"/api/jobs/{job_id}/download")
    assert dl.status_code in {200, 409}  # 409 while queued/running, 200 if already done
