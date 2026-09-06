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


def glb_doc(data: bytes) -> dict:
    """The JSON chunk of a GLB, which is where names, transforms and materials land."""
    assert data[:4] == b"glTF", "not a GLB"
    length = struct.unpack("<I", data[12:16])[0]
    return json.loads(data[20:20 + length])


def glb_node_names(data: bytes) -> list[str]:
    return [n.get("name", "") for n in glb_doc(data).get("nodes", [])]


def glb_node(data: bytes, name: str) -> dict:
    for node in glb_doc(data).get("nodes", []):
        if node.get("name") == name:
            return node
    pytest.fail(f"no node named {name!r} in the GLB")


def make_glb(*names: str) -> bytes:
    """A GLB of one triangle drawn once per name -- the smallest many-part model.

    Every fixture that ships with the tests is a single part, and a removal has
    nothing to prove on a model with one of them: the interesting case is the
    parts that stay behind.
    """
    tri = struct.pack("<9f", 0, 0, 0, 1, 0, 0, 0, 1, 0)
    doc = {
        "asset": {"version": "2.0"},
        "scene": 0,
        "scenes": [{"nodes": list(range(len(names)))}],
        "nodes": [{"name": name, "mesh": 0} for name in names],
        "meshes": [{"primitives": [{"attributes": {"POSITION": 0}}]}],
        "accessors": [{"bufferView": 0, "componentType": 5126, "count": 3,
                       "type": "VEC3", "min": [0, 0, 0], "max": [1, 1, 0]}],
        "bufferViews": [{"buffer": 0, "byteOffset": 0, "byteLength": len(tri)}],
        "buffers": [{"byteLength": len(tri)}],
    }
    body = json.dumps(doc).encode()
    body += b" " * (-len(body) % 4)
    blob = tri + bytes(-len(tri) % 4)
    chunks = (struct.pack("<II", len(body), 0x4E4F534A) + body
              + struct.pack("<II", len(blob), 0x004E4942) + blob)
    return struct.pack("<4sII", b"glTF", 2, 12 + len(chunks)) + chunks


def glb_material(data: bytes, node: dict) -> dict:
    """The material on a node's first mesh primitive."""
    doc = glb_doc(data)
    assert "mesh" in node, f"node {node.get('name')!r} draws nothing"
    primitive = doc["meshes"][node["mesh"]]["primitives"][0]
    assert "material" in primitive, "primitive carries no material"
    return doc["materials"][primitive["material"]]


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


def test_part_edits_drop_the_ones_left_alone():
    from app.main import Options

    opts = Options(edits={
        "untouched": {},
        "nudged": {"move": [0.0, 0.5, 0.0]},
        "restyled": {"material": "metal", "color": "#ff0000"},
    })
    # A part the user selected and never changed carries a default edit.
    assert set(opts.edits) == {"nudged", "restyled"}

    with pytest.raises(ValidationError):
        Options(edits={"a": {"scale": [1.0, 0.0, 1.0]}})   # a part cannot vanish
    with pytest.raises(ValidationError):
        Options(edits={"a": {"scale": [1.0, -2.0, 1.0]}})  # nor turn inside out
    with pytest.raises(ValidationError):
        Options(edits={"a": {"scale": [2.0, 2.0]}})        # must be three axes
    with pytest.raises(ValidationError):
        Options(edits={"a": {"material": "velvet"}})  # not a preset we ship
    with pytest.raises(ValidationError):
        Options(edits={"a": {"move": [1.0, 2.0]}})    # must be three axes
    with pytest.raises(ValidationError):
        Options(edits={"a": {"move": [float("nan"), 0.0, 0.0]}})
    with pytest.raises(ValidationError):
        Options(edits={str(i): {"scale": 2.0} for i in range(501)})


@needs_blender
def test_reexport_moves_scales_and_restyles_a_part():
    job = run_job("cube.stl", CUBE_STL.read_bytes(), ".glb")
    assert job["status"] == "done", job["error"]
    original = client.get(f"/api/jobs/{job['id']}/download").content
    name = glb_node_names(original)[0]
    was = glb_node(original, name).get("translation", [0.0, 0.0, 0.0])

    r = client.post(
        f"/api/jobs/{job['id']}/reexport",
        data={"target": ".glb", "options": json.dumps({"edits": {name: {
            "move": [1.0, 2.0, 3.0], "rotate": [0.0, 0.0, 0.0],
            "scale": [2.0, 2.0, 2.0], "material": "metal", "color": "#ff0000"}}})},
    )
    assert r.status_code == 202, r.text
    again = await_job(r.json()["id"])
    assert again["status"] == "done", again["error"]

    data = client.get(f"/api/jobs/{again['id']}/download").content
    node = glb_node(data, name)
    # The move was authored in the viewer's glTF axes, so it must land in the
    # exported file unrotated -- not swapped into Blender's Z-up.
    assert node["translation"] == pytest.approx(
        [was[0] + 1.0, was[1] + 2.0, was[2] + 3.0], abs=1e-4)
    assert node.get("scale", [1, 1, 1]) == pytest.approx([2.0, 2.0, 2.0], abs=1e-4)

    pbr = glb_material(data, node)["pbrMetallicRoughness"]
    assert pbr["baseColorFactor"] == pytest.approx([1.0, 0.0, 0.0, 1.0], abs=1e-3)
    # glTF omits metallicFactor when it is 1.0, which is what "metal" means.
    assert pbr.get("metallicFactor", 1.0) == pytest.approx(1.0)


def test_opacity_and_finish_are_part_of_an_edit():
    from app.main import Options

    # Fading a part is an edit in its own right, with no material chosen.
    opts = Options(edits={"clear": {"opacity": 0.4}})
    assert set(opts.edits) == {"clear"}
    # A material with no finish given falls back to the preset's own.
    opts = Options(edits={"a": {"material": "metal"}})
    assert opts.edits["a"].roughness is None
    assert opts.edits["a"].metalness is None

    with pytest.raises(ValidationError):
        Options(edits={"a": {"opacity": 0.0}})    # invisible is deletion, not an edit
    with pytest.raises(ValidationError):
        Options(edits={"a": {"opacity": 1.5}})
    with pytest.raises(ValidationError):
        Options(edits={"a": {"roughness": -0.1}})
    with pytest.raises(ValidationError):
        Options(edits={"a": {"metalness": 2.0}})


@needs_blender
def test_reexport_fades_a_part_that_keeps_its_own_material():
    job = run_job("pair.glb", make_glb("Housing", "Cover"), ".glb")
    r = client.post(
        f"/api/jobs/{job['id']}/reexport",
        data={"target": ".glb",
              "options": json.dumps({"edits": {"Cover": {"opacity": 0.35}}})},
    )
    again = await_job(r.json()["id"])
    assert again["status"] == "done", again["error"]

    data = client.get(f"/api/jobs/{again['id']}/download").content
    material = glb_material(data, glb_node(data, "Cover"))
    assert material.get("alphaMode") == "BLEND", material
    assert material["pbrMetallicRoughness"]["baseColorFactor"][3] == pytest.approx(
        0.35, abs=1e-3)
    # Fading one part gives that part a material to fade; the part left alone
    # keeps the nothing it arrived with rather than being dragged along.
    doc = glb_doc(data)
    housing = doc["meshes"][glb_node(data, "Housing")["mesh"]]["primitives"][0]
    assert "material" not in housing, housing


@needs_blender
def test_reexport_writes_the_finish_sliders_onto_a_preset():
    job = run_job("pair.glb", make_glb("Housing", "Cover"), ".glb")
    r = client.post(
        f"/api/jobs/{job['id']}/reexport",
        data={"target": ".glb", "options": json.dumps({"edits": {"Housing": {
            "material": "metal", "color": "#3366ff",
            "roughness": 0.8, "metalness": 0.2, "opacity": 0.5}}})},
    )
    again = await_job(r.json()["id"])
    assert again["status"] == "done", again["error"]

    data = client.get(f"/api/jobs/{again['id']}/download").content
    material = glb_material(data, glb_node(data, "Housing"))
    pbr = material["pbrMetallicRoughness"]
    # The sliders win over the preset's own 0.25 / 1.0.
    assert pbr["roughnessFactor"] == pytest.approx(0.8, abs=1e-3)
    assert pbr["metallicFactor"] == pytest.approx(0.2, abs=1e-3)
    assert material.get("alphaMode") == "BLEND", material
    assert pbr["baseColorFactor"][3] == pytest.approx(0.5, abs=1e-3)


def test_removals_are_deduplicated_and_capped():
    from app.main import Options

    opts = Options(remove=["hub", "hub", "", "spoke"])
    # Order is kept, so the job log reads the way the list did.
    assert opts.remove == ["hub", "spoke"]

    with pytest.raises(ValidationError):
        Options(remove=[f"p{i}" for i in range(501)])


@needs_blender
def test_reexport_drops_a_removed_part_and_keeps_the_rest():
    job = run_job("pair.glb", make_glb("Housing", "Cover"), ".glb")
    assert job["status"] == "done", job["error"]
    assert set(glb_node_names(
        client.get(f"/api/jobs/{job['id']}/download").content)) >= {"Housing", "Cover"}

    r = client.post(
        f"/api/jobs/{job['id']}/reexport",
        data={"target": ".glb", "options": json.dumps({"remove": ["Cover"]})},
    )
    assert r.status_code == 202, r.text
    again = await_job(r.json()["id"])
    assert again["status"] == "done", again["error"]

    names = glb_node_names(client.get(f"/api/jobs/{again['id']}/download").content)
    assert "Housing" in names
    assert "Cover" not in names


@needs_blender
def test_removing_a_part_that_is_not_there_warns_and_exports_anyway():
    job = run_job("pair.glb", make_glb("Housing", "Cover"), ".glb")
    r = client.post(
        f"/api/jobs/{job['id']}/reexport",
        data={"target": ".glb", "options": json.dumps({"remove": ["Flywheel"]})},
    )
    again = await_job(r.json()["id"])
    assert again["status"] == "done", again["error"]
    assert any("Flywheel" in w for w in again["warnings"]), again["warnings"]
    assert "Housing" in glb_node_names(
        client.get(f"/api/jobs/{again['id']}/download").content)


@needs_blender
def test_removing_every_part_fails_rather_than_writing_an_empty_model():
    job = run_job("pair.glb", make_glb("Housing", "Cover"), ".glb")
    r = client.post(
        f"/api/jobs/{job['id']}/reexport",
        data={"target": ".glb",
              "options": json.dumps({"remove": ["Housing", "Cover"]})},
    )
    again = await_job(r.json()["id"])
    assert again["status"] == "error"
    assert "removed" in (again["error"] or "").lower(), again["error"]


@needs_blender
def test_reexport_rotates_a_part_about_the_viewers_axes():
    job = run_job("cube.stl", CUBE_STL.read_bytes(), ".glb")
    assert job["resultStats"]["dimensions"] == pytest.approx([2.0, 1.0, 3.0], abs=1e-4)
    name = glb_node_names(client.get(f"/api/jobs/{job['id']}/download").content)[0]

    r = client.post(
        f"/api/jobs/{job['id']}/reexport",
        data={"target": ".glb", "options": json.dumps(
            {"edits": {name: {"rotate": [0.0, 90.0, 0.0]}}})},
    )
    again = await_job(r.json()["id"])
    assert again["status"] == "done", again["error"]

    # The viewer's Y is Blender's Z, so a quarter turn about it swaps the box's
    # X and Y and leaves its height alone. Getting the axis mapping wrong would
    # tip the box over instead, giving [3, 1, 2] or [2, 3, 1].
    assert again["resultStats"]["dimensions"] == pytest.approx(
        [1.0, 2.0, 3.0], abs=1e-3)


@needs_blender
def test_reexport_scales_each_axis_independently():
    job = run_job("cube.stl", CUBE_STL.read_bytes(), ".glb")
    name = glb_node_names(client.get(f"/api/jobs/{job['id']}/download").content)[0]

    r = client.post(
        f"/api/jobs/{job['id']}/reexport",
        data={"target": ".glb", "options": json.dumps(
            {"edits": {name: {"scale": [3.0, 1.0, 0.5]}}})},
    )
    again = await_job(r.json()["id"])
    assert again["status"] == "done", again["error"]

    data = client.get(f"/api/jobs/{again['id']}/download").content
    assert glb_node(data, name).get("scale") == pytest.approx([3.0, 1.0, 0.5], abs=1e-4)


@needs_blender
def test_names_with_reserved_characters_survive_a_round_trip():
    """Maya and Sketchfab namespace their parts with a colon.

    three.js strips ``[ ] . : /`` from node names when it loads a glTF, so the
    viewer has to recover the file's own name -- an edit keyed by the sanitised
    one matches nothing. This is the backend half: a colon has to survive being
    written, read back and then used as an edit key.
    """
    job = run_job("cube.stl", CUBE_STL.read_bytes(), ".glb")
    name = glb_node_names(client.get(f"/api/jobs/{job['id']}/download").content)[0]

    r = client.post(
        f"/api/jobs/{job['id']}/reexport",
        data={"target": ".glb",
              "options": json.dumps({"renames": {name: "Vanquish:SK_Hood_101"}})},
    )
    renamed = await_job(r.json()["id"])
    assert renamed["status"] == "done", renamed["error"]
    body = client.get(f"/api/jobs/{renamed['id']}/download").content
    assert "Vanquish:SK_Hood_101" in glb_node_names(body)

    # Re-upload that file, so the colon is genuinely the name of the part the
    # next job imports -- a re-export would go back to the original cube.stl.
    again = run_job("hood.glb", body, ".glb")
    assert "Vanquish:SK_Hood_101" in glb_node_names(
        client.get(f"/api/jobs/{again['id']}/download").content)

    r = client.post(
        f"/api/jobs/{again['id']}/reexport",
        data={"target": ".glb", "options": json.dumps(
            {"edits": {"Vanquish:SK_Hood_101": {"move": [0.0, 2.0, 0.0]}}})},
    )
    moved = await_job(r.json()["id"])
    assert moved["status"] == "done", moved["error"]
    assert not moved["warnings"], moved["warnings"]
    node = glb_node(client.get(f"/api/jobs/{moved['id']}/download").content,
                    "Vanquish:SK_Hood_101")
    assert node.get("translation", [0, 0, 0])[1] == pytest.approx(2.0, abs=1e-4)


@needs_blender
def test_an_edit_naming_no_part_is_reported_not_swallowed():
    job = run_job("cube.stl", CUBE_STL.read_bytes(), ".glb")

    r = client.post(
        f"/api/jobs/{job['id']}/reexport",
        data={"target": ".glb", "options": json.dumps(
            {"edits": {"NoSuchPart": {"move": [1.0, 0.0, 0.0]}}})},
    )
    again = await_job(r.json()["id"])
    # The export still succeeds -- but silently returning an unedited model is
    # exactly what makes this look like a bug, so it has to say something.
    assert again["status"] == "done", again["error"]
    assert any("NoSuchPart" in w for w in again["warnings"]), again["warnings"]


@needs_blender
def test_styling_one_part_does_not_bleed_onto_another_in_obj():
    """OBJ's ``usemtl`` is a running state, so an unstyled part written after a
    styled one used to inherit its colour."""
    job = run_job("cube.stl", CUBE_STL.read_bytes(), ".glb")
    name = glb_node_names(client.get(f"/api/jobs/{job['id']}/download").content)[0]

    r = client.post(
        f"/api/jobs/{job['id']}/reexport",
        data={"target": ".obj", "options": json.dumps(
            {"edits": {name: {"material": "metal", "color": "#ff0000"}}})},
    )
    again = await_job(r.json()["id"])
    assert again["status"] == "done", again["error"]

    body = client.get(f"/api/jobs/{again['id']}/download").content
    with zipfile.ZipFile(io.BytesIO(body)) as zf:
        obj = next(n for n in zf.namelist() if n.endswith(".obj"))
        text = zf.read(obj).decode("utf-8", "replace")
    groups = [ln for ln in text.splitlines() if ln.startswith(("o ", "usemtl "))]
    # Every object that appears must carry its own usemtl, so none can inherit.
    objects = [ln for ln in groups if ln.startswith("o ")]
    assert len(objects) == sum(1 for ln in groups if ln.startswith("usemtl ")), groups


@needs_blender
def test_reexport_can_change_format_at_the_same_time():
    job = run_job("cube.stl", CUBE_STL.read_bytes(), ".glb")
    r = client.post(f"/api/jobs/{job['id']}/reexport",
                    data={"target": ".usdz", "options": "{}"})
    assert r.status_code == 202, r.text
    again = await_job(r.json()["id"])
    assert again["status"] == "done", again["error"]
    assert again["downloadName"].endswith(".usdz"), again["downloadName"]
