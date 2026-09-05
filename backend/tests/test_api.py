"""End-to-end tests. The conversion cases drive a real headless Blender."""

from __future__ import annotations

import io
import json
import os
import struct
import time
import zipfile
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

os.environ.setdefault("CONVERTER_DATA_DIR", str(Path(__file__).parent / "_data"))

from pydantic import ValidationError  # noqa: E402

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

def await_job(job_id: str, timeout: float = 240.0) -> dict:
    deadline = time.time() + timeout
    while time.time() < deadline:
        job = client.get(f"/api/jobs/{job_id}").json()
        if job["status"] in {"done", "error"}:
            return job
        time.sleep(0.4)
    pytest.fail(f"job {job_id} did not finish within {timeout}s")


def run_job(filename: str, payload: bytes, target: str, options: dict | None = None,
            timeout: float = 240.0) -> dict:
    r = client.post(
        "/api/convert",
        files={"file": (filename, payload, "application/octet-stream")},
        data={"target": target, "options": json.dumps(options or {})},
    )
    assert r.status_code == 202, r.text
    return await_job(r.json()["id"], timeout)


def glb_node_names(data: bytes) -> list[str]:
    """Node names out of a GLB's JSON chunk, which is where part names land."""
    assert data[:4] == b"glTF", "not a GLB"
    length = struct.unpack("<I", data[12:16])[0]
    doc = json.loads(data[20:20 + length])
    return [n.get("name", "") for n in doc.get("nodes", [])]


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


@needs_blender
def test_zip_archive_converts_and_keeps_sidecar_materials():
    """A zipped OBJ+MTL must convert *with* materials -- that is the point of
    accepting archives, since a bare .obj loses them."""
    obj = b"mtllib box.mtl\nusemtl Red\nv 0 0 0\nv 1 0 0\nv 1 1 0\nf 1 2 3\n"
    mtl = b"newmtl Red\nKd 0.9 0.1 0.1\n"
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("box.obj", obj)
        zf.writestr("box.mtl", mtl)

    job = run_job("bundle.zip", buf.getvalue(), ".glb")
    assert job["status"] == "done", job["error"]
    assert job["resultStats"]["materials"] >= 1, "material from the .mtl was lost"
    # Downloads are named after the model inside, not the archive.
    assert job["downloadName"] == "box.glb"
    assert client.get(f"/api/jobs/{job['id']}/download").status_code == 200


@needs_blender
def test_zip_without_a_model_fails_with_a_clear_message():
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("readme.txt", b"nothing to convert here")
    job = run_job("empty.zip", buf.getvalue(), ".glb")
    assert job["status"] == "error"
    assert "No convertible model" in job["error"]


def _tiny_png() -> bytes:
    """Smallest valid 1x1 PNG."""
    import base64
    return base64.b64decode(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
    )


def _glb_images(payload: bytes) -> list:
    """Read the image list out of a GLB's JSON chunk."""
    import struct
    json_len = struct.unpack_from("<I", payload, 12)[0]
    doc = json.loads(payload[20:20 + json_len].decode("utf-8"))
    return doc.get("images", [])


@needs_blender
def test_textures_are_relinked_when_the_mtl_has_absolute_paths():
    """Marketplace archives routinely ship an .mtl full of the author's own
    absolute paths while the images sit in a sibling textures/ folder. Those
    must still make it into the output."""
    obj = b"mtllib m.mtl\nusemtl T\nv 0 0 0\nv 1 0 0\nv 1 1 0\nvt 0 0\nvt 1 0\nvt 1 1\nf 1/1 2/2 3/3\n"
    mtl = b"newmtl T\nKd 1 1 1\nmap_Kd C:/Users/someone/desktop/albedo.png\n"
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("source/thing.obj", obj)
        zf.writestr("source/m.mtl", mtl)
        zf.writestr("textures/albedo.png", _tiny_png())

    job = run_job("relink.zip", buf.getvalue(), ".glb")
    assert job["status"] == "done", job["error"]
    assert any("Relinked" in line for line in job["log"]), job["log"][-15:]

    payload = client.get(f"/api/jobs/{job['id']}/download").content
    assert _glb_images(payload), "texture was not carried into the GLB"


@needs_blender
def test_relinking_never_binds_a_differently_named_image():
    """Matching is by exact filename so a wrong texture is never substituted."""
    obj = b"mtllib m.mtl\nusemtl T\nv 0 0 0\nv 1 0 0\nv 1 1 0\nf 1 2 3\n"
    mtl = b"newmtl T\nKd 1 1 1\nmap_Kd C:/nope/missing.png\n"
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("thing.obj", obj)
        zf.writestr("m.mtl", mtl)
        zf.writestr("textures/something_else.png", _tiny_png())

    job = run_job("norelink.zip", buf.getvalue(), ".glb")
    assert job["status"] == "done", job["error"]
    payload = client.get(f"/api/jobs/{job['id']}/download").content
    assert not _glb_images(payload), "an unrelated image was bound to the material"


def test_zip_is_advertised_as_input_only():
    body = client.get("/api/formats").json()
    assert ".zip" in body["inputs"]
    assert ".zip" not in body["outputs"]


def test_download_before_completion_is_rejected():
    r = client.post(
        "/api/convert",
        files={"file": ("cube.stl", CUBE_STL.read_bytes(), "model/stl")},
        data={"target": ".glb"},
    )
    job_id = r.json()["id"]
    dl = client.get(f"/api/jobs/{job_id}/download")
    assert dl.status_code in {200, 409}  # 409 while queued/running, 200 if already done


# --- part names --------------------------------------------------------------

def test_reexport_of_an_unknown_job_is_404():
    r = client.post("/api/jobs/deadbeef/reexport", data={"target": ".glb"})
    assert r.status_code == 404


def test_rename_values_are_cleaned_and_capped():
    from app.main import Options

    opts = Options(renames={"a": "  Front   Panel \n", "b": "b", "c": ""})
    # Whitespace collapses; a no-op rename and an empty name are dropped.
    assert opts.renames == {"a": "Front Panel"}

    with pytest.raises(ValidationError):
        Options(renames={str(i): f"n{i}" for i in range(501)})


@needs_blender
def test_reexport_renames_parts_in_the_output():
    job = run_job("cube.stl", CUBE_STL.read_bytes(), ".glb")
    assert job["status"] == "done", job["error"]
    names = glb_node_names(client.get(f"/api/jobs/{job['id']}/download").content)
    assert names, "nothing in the GLB carries a name"

    r = client.post(
        f"/api/jobs/{job['id']}/reexport",
        data={"target": ".glb",
              "options": json.dumps({"renames": {names[0]: "Housing"}})},
    )
    assert r.status_code == 202, r.text
    again = await_job(r.json()["id"])
    assert again["status"] == "done", again["error"]
    assert again["id"] != job["id"], "re-export must not overwrite the original job"
    assert "Housing" in glb_node_names(
        client.get(f"/api/jobs/{again['id']}/download").content)


@needs_blender
def test_reexport_can_change_format_at_the_same_time():
    job = run_job("cube.stl", CUBE_STL.read_bytes(), ".glb")
    r = client.post(f"/api/jobs/{job['id']}/reexport",
                    data={"target": ".usdz", "options": "{}"})
    assert r.status_code == 202, r.text
    again = await_job(r.json()["id"])
    assert again["status"] == "done", again["error"]
    assert again["downloadName"].endswith(".usdz"), again["downloadName"]
