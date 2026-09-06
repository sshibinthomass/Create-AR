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


def test_collada_upload_is_told_what_to_upload_instead():
    r = client.post(
        "/api/convert",
        files={"file": ("model.dae", b"<COLLADA/>", "model/vnd.collada+xml")},
        data={"target": ".glb"},
    )
    assert r.status_code == 400
    detail = r.json()["detail"]
    assert "COLLADA" in detail
    assert "GLB" in detail


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


def test_recolouring_keeps_the_part_a_change_worth_saving():
    """A colour with no preset is a real edit, and must survive `is_noop`.

    Everything else about such an edit looks untouched -- no material, full
    opacity, no move -- so without the flag it is filtered out as a part the
    user never changed, and the colour silently never reaches the file.
    """
    from app.main import Options, PartEdit

    assert PartEdit().recolor is False
    assert PartEdit().is_noop()
    # The colour alone, with the part's own material left in place.
    assert not PartEdit(color="#ff2d2d", recolor=True).is_noop()
    # A colour nobody asked to apply is still nothing.
    assert PartEdit(color="#ff2d2d").is_noop()

    opts = Options(edits={
        "tinted": {"color": "#ff2d2d", "recolor": True},
        "just a colour": {"color": "#ff2d2d"},
    })
    assert set(opts.edits) == {"tinted"}
    assert opts.edits["tinted"].material == ""   # the finish is left alone


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


# --- animation ---------------------------------------------------------------

def glb_animation(data: bytes, name: str) -> dict:
    for anim in glb_doc(data).get("animations", []):
        if anim.get("name") == name:
            return anim
    pytest.fail(f"no animation named {name!r}; got "
                f"{[a.get('name') for a in glb_doc(data).get('animations', [])]}")


def glb_channel_values(data: bytes, anim: dict, node_name: str, path: str) -> list[list[float]]:
    """Every sample of one channel, decoded from the binary chunk."""
    doc = glb_doc(data)
    nodes = doc["nodes"]
    channel = next(
        (c for c in anim["channels"]
         if nodes[c["target"]["node"]].get("name") == node_name and c["target"]["path"] == path),
        None)
    assert channel is not None, f"{anim.get('name')!r} has no {path} channel on {node_name!r}"
    sampler = anim["samplers"][channel["sampler"]]
    accessor = doc["accessors"][sampler["output"]]
    view = doc["bufferViews"][accessor["bufferView"]]
    json_len = struct.unpack("<I", data[12:16])[0]
    start = 20 + json_len + 8 + view.get("byteOffset", 0) + accessor.get("byteOffset", 0)
    width = {"VEC3": 3, "VEC4": 4}[accessor["type"]]
    floats = struct.unpack_from(f"<{accessor['count'] * width}f", data, start)
    return [list(floats[i:i + width]) for i in range(0, len(floats), width)]


def test_formats_say_which_can_carry_animation():
    body = client.get("/api/formats").json()
    by_ext = {f["ext"]: f for f in body["formats"]}
    for ext in (".glb", ".gltf", ".usdz", ".fbx", ".abc"):
        assert by_ext[ext]["can_animate"] is True, ext
    for ext in (".obj", ".stl", ".ply"):
        assert by_ext[ext]["can_animate"] is False, ext


def test_clips_are_cleaned_and_capped():
    from app.main import Options

    opts = Options(clips=[{
        "name": "  Spin\tup ",
        "duration": 2.0,
        "tracks": [
            # Keys arrive in any order, and one per moment: the later wins.
            {"target": "a", "keys": [
                {"time": 3.0, "move": [1, 0, 0]},   # past the end: never reached
                {"time": 1.0, "rotate": [0, 90, 0]},
                {"time": 1.0, "rotate": [0, 360, 0]},
                {"time": 0.0},
            ]},
            {"target": "b", "keys": []},            # nothing to write
            {"target": "", "pivot": [1, 2, 3], "keys": [{"time": 0.5}]},
        ],
    }, {"name": "Empty", "tracks": []}])

    assert len(opts.clips) == 1
    clip = opts.clips[0]
    assert clip.name == "Spin up"
    assert [t.target for t in clip.tracks] == ["a", ""]
    assert [k.time for k in clip.tracks[0].keys] == [0.0, 1.0]
    # A full turn is kept as a full turn, not folded back to nothing.
    assert clip.tracks[0].keys[1].rotate == [0.0, 360.0, 0.0]
    assert clip.tracks[1].pivot == [1.0, 2.0, 3.0]

    with pytest.raises(ValidationError):
        Options(clips=[{"duration": 0.0}])
    with pytest.raises(ValidationError):
        Options(clips=[{"tracks": [{"target": "a", "keys": [{"time": -1.0}]}]}])
    with pytest.raises(ValidationError):
        Options(clips=[{"tracks": [{"target": "a", "keys": [{"time": 0, "scale": [0, 1, 1]}]}]}])
    with pytest.raises(ValidationError):
        Options(clips=[{"tracks": [{"target": "a", "keys": []}]}] * 33)


def _lift_from_blender_job(name):
    """One function out of blender_job.py, without importing bpy.

    The animation block is deliberately free of Blender types -- it is the half
    of the exporter that has to agree with the browser -- so it can be compiled
    and run on its own.
    """
    import pathlib

    src = (pathlib.Path(__file__).resolve().parents[1] / "app" / "blender_job.py").read_text(
        encoding="utf-8")
    block = src[src.index("def _shape("):src.index("def write_samples(")]
    scope = {}
    exec(compile(block, "blender_job.py", "exec"), scope)
    return scope[name]


def test_keyframe_easing_is_optional_and_checked():
    from app.main import Options

    opts = Options(clips=[{
        "duration": 2.0,
        "tracks": [{"target": "a", "keys": [
            {"time": 0.0, "ease": "smooth"},
            {"time": 1.0, "ease": "hold"},
            {"time": 2.0},                      # a caller that predates easing
        ]}],
    }])
    keys = opts.clips[0].tracks[0].keys
    assert [k.ease for k in keys] == ["smooth", "hold", "linear"]

    with pytest.raises(ValidationError):
        Options(clips=[{"tracks": [
            {"target": "a", "keys": [{"time": 0.0, "ease": "bounce"}]}]}])


def test_sampling_follows_the_ease_of_the_key_being_left():
    """The baker has to match `poseAt` in the browser, or the saved file plays
    differently from the preview it was built in."""
    # blender_job runs inside Blender and imports bpy at the top, so it cannot
    # be imported here. The sampling itself is plain arithmetic on dicts, so it
    # is lifted out of the source and exercised on its own.
    sample_pose = _lift_from_blender_job("sample_pose")

    keys = [
        {"time": 0.0, "move": [0, 0, 0], "rotate": [0, 0, 0], "scale": [1, 1, 1],
         "ease": "linear"},
        {"time": 1.0, "move": [10, 0, 0], "rotate": [0, 0, 0], "scale": [1, 1, 1],
         "ease": "hold"},
        {"time": 2.0, "move": [20, 0, 0], "rotate": [0, 0, 0], "scale": [1, 1, 1],
         "ease": "smooth"},
        {"time": 3.0, "move": [30, 0, 0], "rotate": [0, 0, 0], "scale": [1, 1, 1]},
    ]
    # Linear: straight through the middle of the first second.
    assert sample_pose(keys, 0.5)["move"][0] == pytest.approx(5.0)
    # Hold: the part stays where it was for the whole span. The step belongs to
    # the moment *after* the next key -- the earlier key owns its own boundary,
    # which is what `poseAt` does too, so preview and file step on the same frame.
    assert sample_pose(keys, 1.5)["move"][0] == pytest.approx(10.0)
    assert sample_pose(keys, 1.999)["move"][0] == pytest.approx(10.0)
    assert sample_pose(keys, 2.0)["move"][0] == pytest.approx(10.0)
    assert sample_pose(keys, 2.001)["move"][0] == pytest.approx(20.0, abs=1e-3)
    # Smooth: symmetric about the middle, and slower than linear at the ends.
    assert sample_pose(keys, 2.5)["move"][0] == pytest.approx(25.0)
    assert sample_pose(keys, 2.25)["move"][0] == pytest.approx(21.5625)
    assert sample_pose(keys, 2.75)["move"][0] == pytest.approx(28.4375)
    # Held before the first key and after the last, as before.
    assert sample_pose(keys, -1.0)["move"][0] == 0.0
    assert sample_pose(keys, 99.0)["move"][0] == 30.0


def test_clips_are_refused_on_a_format_that_cannot_carry_them():
    clips = [{"name": "Spin", "duration": 1.0,
              "tracks": [{"target": "a", "keys": [{"time": 0.0}, {"time": 1.0}]}]}]
    r = client.post(
        "/api/convert",
        files={"file": ("cube.stl", CUBE_STL.read_bytes(), "application/octet-stream")},
        data={"target": ".obj", "options": json.dumps({"clips": clips})},
    )
    assert r.status_code == 400
    assert "cannot carry animation" in r.json()["detail"]
    assert ".glb" in r.json()["detail"]


@needs_blender
def test_reexport_writes_each_clip_as_a_named_gltf_animation():
    job = run_job("rig.glb", make_glb("Wheel", "Arm"), ".glb")
    assert job["status"] == "done", job["error"]
    before = client.get(f"/api/jobs/{job['id']}/download").content
    arm_was = glb_node(before, "Arm").get("translation", [0.0, 0.0, 0.0])

    clips = [
        {"name": "Spin", "duration": 1.0, "tracks": [
            # A full turn about the viewer's Y over the clip.
            {"target": "Wheel", "keys": [
                {"time": 0.0}, {"time": 1.0, "rotate": [0.0, 360.0, 0.0]}]},
            # The arm rises one unit, on top of a static edit that already
            # pushed it one unit along Z: the clip is a delta on the edit.
            {"target": "Arm", "keys": [
                {"time": 0.0}, {"time": 1.0, "move": [0.0, 1.0, 0.0]}]},
        ]},
        {"name": "Lift", "duration": 0.5, "tracks": [
            # The whole model, about the pivot the viewer measured.
            {"target": "", "pivot": [0.5, 0.5, 0.0], "keys": [
                {"time": 0.0}, {"time": 0.5, "move": [0.0, 2.0, 0.0]}]},
        ]},
    ]
    r = client.post(
        f"/api/jobs/{job['id']}/reexport",
        data={"target": ".glb", "options": json.dumps({
            "edits": {"Arm": {"move": [0.0, 0.0, 1.0]}},
            "clips": clips,
        })},
    )
    assert r.status_code == 202, r.text
    again = await_job(r.json()["id"])
    assert again["status"] == "done", again["error"]
    assert not again["warnings"], again["warnings"]

    data = client.get(f"/api/jobs/{again['id']}/download").content
    doc = glb_doc(data)
    assert sorted(a["name"] for a in doc["animations"]) == ["Lift", "Spin"]

    spin = glb_animation(data, "Spin")
    times = doc["accessors"][spin["samplers"][0]["input"]]
    assert times["min"] == pytest.approx([0.0], abs=1e-3)
    assert times["max"] == pytest.approx([1.0], abs=1e-3)

    # The arm starts where its edit put it and ends one unit higher. Its
    # channel is relative to its parent -- and the whole-model clip has hung
    # every part from a new root sitting on the pivot, so that is taken off.
    pivot = [0.5, 0.5, 0.0]
    origin = [arm_was[i] - pivot[i] for i in range(3)]
    arm = glb_channel_values(data, spin, "Arm", "translation")
    assert arm[0] == pytest.approx([origin[0], origin[1], origin[2] + 1.0], abs=1e-3)
    assert arm[-1] == pytest.approx([origin[0], origin[1] + 1.0, origin[2] + 1.0], abs=1e-3)

    # A full turn: the wheel is back where it started, having been elsewhere
    # halfway. Quaternions, so a half turn about Y is (0, +-1, 0, 0).
    wheel = glb_channel_values(data, spin, "Wheel", "rotation")
    assert abs(wheel[0][3]) == pytest.approx(1.0, abs=1e-3)
    assert abs(wheel[-1][3]) == pytest.approx(1.0, abs=1e-3)
    assert abs(wheel[len(wheel) // 2][1]) == pytest.approx(1.0, abs=1e-2)

    # The whole-model clip animates a new root the parts now hang from, and
    # that root sits on the pivot.
    lift = glb_animation(data, "Lift")
    root_index = lift["channels"][0]["target"]["node"]
    root = doc["nodes"][root_index]
    assert "mesh" not in root
    assert set(root.get("children", [])) == {
        i for i, n in enumerate(doc["nodes"]) if n.get("name") in {"Wheel", "Arm"}}
    assert root.get("translation") == pytest.approx([0.5, 0.5, 0.0], abs=1e-3)
    moved = glb_channel_values(data, lift, root["name"], "translation")
    assert moved[-1] == pytest.approx([0.5, 2.5, 0.0], abs=1e-3)


@needs_blender
@pytest.mark.parametrize("target", [".usda", ".fbx"])
def test_clips_reach_the_single_timeline_formats(target):
    job = run_job("pair.glb", make_glb("Housing", "Cover"), ".glb")
    clips = [{"name": "Open", "duration": 1.0, "tracks": [
        {"target": "Cover", "keys": [{"time": 0.0}, {"time": 1.0, "move": [0.0, 1.0, 0.0]}]}]}]
    r = client.post(
        f"/api/jobs/{job['id']}/reexport",
        data={"target": target, "options": json.dumps({"clips": clips})},
    )
    assert r.status_code == 202, r.text
    again = await_job(r.json()["id"])
    assert again["status"] == "done", again["error"]
    body = client.get(f"/api/jobs/{again['id']}/download").content
    if target == ".usda":
        text = body.decode("utf-8", "replace")
        assert "timeSamples" in text
        assert "timeCodesPerSecond = 30" in text


@needs_blender
def test_reexport_can_change_format_at_the_same_time():
    job = run_job("cube.stl", CUBE_STL.read_bytes(), ".glb")
    r = client.post(f"/api/jobs/{job['id']}/reexport",
                    data={"target": ".usdz", "options": "{}"})
    assert r.status_code == 202, r.text
    again = await_job(r.json()["id"])
    assert again["status"] == "done", again["error"]
    assert again["downloadName"].endswith(".usdz"), again["downloadName"]


# --- compression -------------------------------------------------------------

def _png(side: int) -> bytes:
    """A valid ``side``x``side`` RGB PNG, so a resolution cap has room to bite."""
    import zlib

    rows = b"".join(
        b"\x00" + bytes(((x * 7) % 256, (y * 11) % 256, 128)[c]
                        for x in range(side) for c in range(3))
        for y in range(side)
    )

    def chunk(tag: bytes, payload: bytes) -> bytes:
        return (struct.pack(">I", len(payload)) + tag + payload
                + struct.pack(">I", zlib.crc32(tag + payload) & 0xFFFFFFFF))

    return (b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", struct.pack(">IIBBBBB", side, side, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(rows))
            + chunk(b"IEND", b""))


def _textured_obj_zip(side: int) -> bytes:
    """A zipped OBJ whose one material points at a ``side``x``side`` texture."""
    obj = (b"mtllib m.mtl\nusemtl T\n"
           b"v 0 0 0\nv 1 0 0\nv 1 1 0\nvt 0 0\nvt 1 0\nvt 1 1\nf 1/1 2/2 3/3\n")
    mtl = b"newmtl T\nKd 1 1 1\nmap_Kd albedo.png\n"
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("thing.obj", obj)
        zf.writestr("m.mtl", mtl)
        zf.writestr("albedo.png", _png(side))
    return buf.getvalue()


def _dense_stl(rows: int) -> bytes:
    """A binary STL grid of ``rows * rows * 2`` triangles.

    The triangle budget deliberately leaves meshes of 64 triangles or fewer
    alone, so the 12-triangle cube fixture cannot exercise it.
    """
    tris: list[tuple] = []
    for y in range(rows):
        for x in range(rows):
            a, b = (x, y, 0.0), (x + 1, y, 0.0)
            c, d = (x + 1, y + 1, 0.0), (x, y + 1, 0.0)
            tris.append((a, b, c))
            tris.append((a, c, d))
    out = b"\x00" * 80 + struct.pack("<I", len(tris))
    for tri in tris:
        out += struct.pack("<3f", 0.0, 0.0, 1.0)
        for v in tri:
            out += struct.pack("<3f", float(v[0]), float(v[1]), float(v[2]))
        out += b"\x00\x00"
    return out


def _glb_image_sizes(payload: bytes) -> list[tuple[int, int]]:
    """Pixel dimensions of every image embedded in a GLB."""
    doc = glb_doc(payload)
    json_len = struct.unpack_from("<I", payload, 12)[0]
    body = 20 + json_len + 8
    sizes = []
    for image in doc.get("images", []):
        view = doc["bufferViews"][image["bufferView"]]
        start = body + view.get("byteOffset", 0)
        blob = payload[start:start + view["byteLength"]]
        if blob[:8] == b"\x89PNG\r\n\x1a\n":
            sizes.append(struct.unpack(">II", blob[16:24]))
        elif blob[:2] == b"\xff\xd8":
            i = 2
            while i < len(blob):
                if blob[i] != 0xFF:
                    i += 1
                    continue
                marker = blob[i + 1]
                if marker in (0xC0, 0xC1, 0xC2, 0xC3):
                    high, wide = struct.unpack(">HH", blob[i + 5:i + 9])
                    sizes.append((wide, high))
                    break
                if marker in (0xD8, 0xD9) or 0xD0 <= marker <= 0xD7:
                    i += 2
                    continue
                i += 2 + struct.unpack(">H", blob[i + 2:i + 4])[0]
    return sizes


@pytest.mark.parametrize("bad", [
    {"texture_format": "avif"},
    {"texture_limit": 99999},
    {"texture_quality": 0},
    {"merge": "everything"},
    {"weld": -1},
    {"tri_budget": -5},
])
def test_rejects_invalid_compression_options(bad):
    r = client.post(
        "/api/convert",
        files={"file": ("cube.stl", CUBE_STL.read_bytes(), "model/stl")},
        data={"target": ".glb", "options": json.dumps(bad)},
    )
    assert r.status_code == 400, r.text


@needs_blender
def test_triangle_budget_lands_at_or_under_the_target():
    job = run_job("grid.stl", _dense_stl(20), ".glb", {"tri_budget": 200})
    assert job["status"] == "done", job["error"]
    assert job["sourceStats"]["triangles"] == 800
    assert job["resultStats"]["triangles"] <= 200, job["resultStats"]


@needs_blender
def test_a_model_already_within_budget_is_left_alone():
    job = run_job("cube.stl", CUBE_STL.read_bytes(), ".glb", {"tri_budget": 1_000_000})
    assert job["status"] == "done", job["error"]
    assert job["resultStats"]["triangles"] == job["sourceStats"]["triangles"]
    assert any("Already within" in line for line in job["log"]), job["log"][-10:]


@needs_blender
def test_a_budget_overrides_the_percentage():
    """Both knobs aim the same reduction, so sending both must not compound."""
    job = run_job("grid.stl", _dense_stl(20), ".glb",
                  {"tri_budget": 400, "decimate": 0.1})
    assert job["status"] == "done", job["error"]
    # 10% of 800 would be 80; the budget is what counts.
    assert 200 <= job["resultStats"]["triangles"] <= 400, job["resultStats"]


@needs_blender
def test_merging_collapses_every_mesh_into_one():
    job = run_job("many.glb", make_glb("A", "B", "C"), ".glb", {"merge": "all"})
    assert job["status"] == "done", job["error"]
    assert job["sourceStats"]["meshes"] == 3
    assert job["resultStats"]["meshes"] == 1, job["resultStats"]


@needs_blender
def test_merging_is_refused_when_the_model_carries_animation():
    """A join keeps one object's action, so it would silently eat the clips."""
    clips = [{"name": "Open", "duration": 1.0, "tracks": [
        {"target": "B", "keys": [{"time": 0.0}, {"time": 1.0, "move": [0.0, 1.0, 0.0]}]}]}]
    job = run_job("many.glb", make_glb("A", "B", "C"), ".glb",
                  {"merge": "all", "clips": clips})
    assert job["status"] == "done", job["error"]
    assert job["resultStats"]["meshes"] == 3, "meshes were merged despite the clips"
    assert any("not merged" in w for w in job["warnings"]), job["warnings"]


@needs_blender
def test_texture_resolution_cap_shrinks_the_embedded_image():
    job = run_job("tex.zip", _textured_obj_zip(64), ".glb", {"texture_limit": 16})
    assert job["status"] == "done", job["error"]
    assert job["sourceStats"]["texturePixels"] == 64 * 64
    assert job["resultStats"]["texturePixels"] == 16 * 16, job["resultStats"]
    payload = client.get(f"/api/jobs/{job['id']}/download").content
    assert _glb_image_sizes(payload) == [(16, 16)], _glb_image_sizes(payload)


@needs_blender
def test_a_texture_already_under_the_cap_is_untouched():
    job = run_job("tex.zip", _textured_obj_zip(8), ".glb", {"texture_limit": 64})
    assert job["status"] == "done", job["error"]
    assert job["resultStats"]["texturePixels"] == 8 * 8


@needs_blender
def test_textures_re_encode_to_jpeg_and_reach_a_copying_exporter():
    """OBJ copies the texture file rather than re-encoding it, so the scaled and
    re-encoded image has to be on disk for it -- not just live in Blender."""
    job = run_job("tex.zip", _textured_obj_zip(64), ".obj",
                  {"texture_limit": 32, "texture_format": "jpeg", "texture_quality": 50})
    assert job["status"] == "done", job["error"]

    payload = client.get(f"/api/jobs/{job['id']}/download").content
    with zipfile.ZipFile(io.BytesIO(payload)) as zf:
        jpegs = [n for n in zf.namelist() if n.lower().endswith(".jpg")]
        assert jpegs, zf.namelist()
        blob = zf.read(jpegs[0])
    assert blob[:2] == b"\xff\xd8", "not a JPEG"
    assert _jpeg_size(blob) == (32, 32), _jpeg_size(blob)


def _jpeg_size(blob: bytes) -> tuple[int, int] | None:
    i = 2
    while i < len(blob):
        if blob[i] != 0xFF:
            i += 1
            continue
        marker = blob[i + 1]
        if marker in (0xC0, 0xC1, 0xC2, 0xC3):
            high, wide = struct.unpack(">HH", blob[i + 5:i + 9])
            return (wide, high)
        if marker in (0xD8, 0xD9) or 0xD0 <= marker <= 0xD7:
            i += 2
            continue
        i += 2 + struct.unpack(">H", blob[i + 2:i + 4])[0]
    return None


@needs_blender
def test_cleaning_and_welding_leave_a_convertible_model():
    job = run_job("cube.stl", CUBE_STL.read_bytes(), ".glb",
                  {"clean": True, "weld": 0.0001})
    assert job["status"] == "done", job["error"]
    assert job["resultStats"]["triangles"] == 12, job["resultStats"]


@needs_blender
def test_the_source_size_is_reported_for_comparison():
    payload = CUBE_STL.read_bytes()
    job = run_job("cube.stl", payload, ".glb")
    assert job["status"] == "done", job["error"]
    assert job["sourceSize"] == len(payload)


def _glb_triangles(payload: bytes) -> int:
    """Triangles the GLB actually carries, counted from its accessors."""
    doc = glb_doc(payload)
    total = 0
    for mesh in doc["meshes"]:
        for prim in mesh["primitives"]:
            key = prim["indices"] if "indices" in prim else prim["attributes"]["POSITION"]
            total += doc["accessors"][key]["count"] // 3
    return total


@needs_blender
def test_reported_triangles_match_what_the_file_carries():
    """Simplify is a modifier, so with 'apply modifiers' off it never reaches the
    export. The stats have to say so rather than claim a reduction that only
    happened in Blender's evaluated mesh."""
    opts = {"decimate": 0.25, "apply_modifiers": False}
    job = run_job("grid.stl", _dense_stl(20), ".glb", opts)
    assert job["status"] == "done", job["error"]

    payload = client.get(f"/api/jobs/{job['id']}/download").content
    assert _glb_triangles(payload) == 800, "the modifier should not have been applied"
    assert job["resultStats"]["triangles"] == 800, job["resultStats"]
    assert any("Apply modifiers" in w for w in job["warnings"]), job["warnings"]


@needs_blender
def test_applying_modifiers_writes_the_reduction_into_the_file():
    job = run_job("grid.stl", _dense_stl(20), ".glb",
                  {"decimate": 0.25, "apply_modifiers": True})
    assert job["status"] == "done", job["error"]
    payload = client.get(f"/api/jobs/{job['id']}/download").content
    assert _glb_triangles(payload) == job["resultStats"]["triangles"]
    assert _glb_triangles(payload) < 800
    assert not any("Apply modifiers" in w for w in job["warnings"]), job["warnings"]


@needs_blender
def test_same_format_in_and_out_is_a_compression_pass():
    """GLB to GLB is not a no-op now that the options can shrink the model --
    it is how you compress a file that is already in the format you want."""
    payload = _textured_obj_zip(64)
    first = run_job("tex.zip", payload, ".glb")
    assert first["status"] == "done", first["error"]
    glb = client.get(f"/api/jobs/{first['id']}/download").content
    assert _glb_image_sizes(glb) == [(64, 64)]

    again = run_job("thing.glb", glb, ".glb",
                    {"texture_limit": 16, "texture_format": "jpeg"})
    assert again["status"] == "done", again["error"]
    assert again["sourceExt"] == ".glb" and again["targetExt"] == ".glb"
    assert again["outputSize"] < first["outputSize"], (
        first["outputSize"], again["outputSize"])

    out = client.get(f"/api/jobs/{again['id']}/download").content
    assert _glb_image_sizes(out) == [(16, 16)], _glb_image_sizes(out)


# --- the SPA -----------------------------------------------------------------

needs_ui_build = pytest.mark.skipif(
    not (config.REPO_DIR / "frontend" / "dist" / "index.html").exists(),
    reason="frontend has not been built",
)


@needs_ui_build
@pytest.mark.parametrize("path", ["/", "/convert", "/analysis", "/settings"])
def test_every_view_has_its_own_address(path):
    r = client.get(path)
    assert r.status_code == 200, path
    assert r.headers["content-type"].startswith("text/html")


@needs_ui_build
def test_missing_asset_and_unknown_api_route_still_404():
    # The index.html fallback must not swallow these: an asset served as HTML
    # breaks in the browser, and a bad API path deserves a straight answer.
    assert client.get("/assets/does-not-exist.js").status_code == 404
    assert client.get("/api/does-not-exist").status_code == 404
