"""Archive input: extraction safety and model discovery."""

from __future__ import annotations

import io
import os
import zipfile
from pathlib import Path

import pytest

os.environ.setdefault("CONVERTER_DATA_DIR", str(Path(__file__).parent / "_data"))

from app import archives  # noqa: E402
from app.archives import ArchiveError  # noqa: E402

FIXTURES = Path(__file__).parent / "fixtures"
CUBE_STL = FIXTURES / "cube.stl"


def make_zip(path: Path, entries: dict[str, bytes]) -> Path:
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as zf:
        for name, data in entries.items():
            zf.writestr(name, data)
    return path


# --- extraction safety -------------------------------------------------------

@pytest.mark.parametrize("evil", [
    "../escaped.txt",
    "../../escaped.txt",
    "sub/../../escaped.txt",
    "/absolute.txt",
])
def test_zip_slip_is_refused(tmp_path, evil):
    archive = make_zip(tmp_path / "evil.zip", {evil: b"pwned", "cube.stl": CUBE_STL.read_bytes()})
    with pytest.raises(ArchiveError, match="escapes"):
        archives.safe_extract(archive, tmp_path / "out")
    assert not (tmp_path / "escaped.txt").exists()
    assert not (tmp_path.parent / "escaped.txt").exists()


def test_backslash_traversal_is_refused(tmp_path):
    archive = tmp_path / "evil.zip"
    with zipfile.ZipFile(archive, "w") as zf:
        zf.writestr("..\\..\\escaped.txt", b"pwned")
    with pytest.raises(ArchiveError, match="escapes"):
        archives.safe_extract(archive, tmp_path / "out")


def test_entry_count_is_capped(tmp_path):
    archive = make_zip(
        tmp_path / "many.zip",
        {f"f{i}.txt": b"x" for i in range(archives.MAX_ENTRIES + 5)},
    )
    with pytest.raises(ArchiveError, match="entries"):
        archives.safe_extract(archive, tmp_path / "out")


def test_decompression_bomb_is_refused(tmp_path):
    # 50 MB of zeros compresses to almost nothing; budget is deliberately tiny.
    archive = make_zip(tmp_path / "bomb.zip", {"big.bin": b"\0" * (50 * 1024 * 1024)})
    with pytest.raises(ArchiveError):
        archives.safe_extract(archive, tmp_path / "out", budget=1024 * 1024)


def test_corrupt_zip_reports_clearly(tmp_path):
    bad = tmp_path / "bad.zip"
    bad.write_bytes(b"PK\x03\x04 this is not really a zip")
    with pytest.raises(ArchiveError, match="corrupt or not a zip"):
        archives.safe_extract(bad, tmp_path / "out")


def test_macos_resource_forks_are_ignored(tmp_path):
    archive = make_zip(tmp_path / "mac.zip", {
        "__MACOSX/._cube.stl": b"junk",
        "._cube.stl": b"junk",
        "cube.stl": CUBE_STL.read_bytes(),
    })
    out = tmp_path / "out"
    archives.safe_extract(archive, out)
    assert not (out / "__MACOSX").exists()
    models = archives.find_models(out)
    assert [p.name for p in models] == ["cube.stl"]


def test_nested_paths_are_preserved(tmp_path):
    """Sidecars must land beside the model or relative references break."""
    archive = make_zip(tmp_path / "bundle.zip", {
        "scene.gltf": b"{}",
        "scene.bin": b"\0\0",
        "textures/albedo.png": b"\x89PNG",
    })
    out = tmp_path / "out"
    archives.safe_extract(archive, out)
    assert (out / "scene.bin").exists()
    assert (out / "textures" / "albedo.png").exists()


# --- model discovery ---------------------------------------------------------

def test_picks_preferred_format_when_several_present(tmp_path):
    archive = make_zip(tmp_path / "multi.zip", {
        "model.stl": CUBE_STL.read_bytes(),
        "model.obj": b"v 0 0 0\n",
        "model.glb": b"glTF\x02\x00\x00\x00",
    })
    model, _ = archives.extract_model(archive, tmp_path / "work")
    assert model.name == "model.glb"  # glb outranks obj outranks stl


def test_shallower_model_wins_over_deeper(tmp_path):
    archive = make_zip(tmp_path / "depth.zip", {
        "deep/nested/model.obj": b"v 0 0 0\n",
        "model.obj": b"v 1 1 1\n",
    })
    model, _ = archives.extract_model(archive, tmp_path / "work")
    assert model.parent.name == "archive"


def test_nested_archive_is_opened_when_top_level_has_no_model(tmp_path):
    inner = io.BytesIO()
    with zipfile.ZipFile(inner, "w") as zf:
        zf.writestr("Thing.obj", b"v 0 0 0\n")
        zf.writestr("Thing.mtl", b"newmtl m\n")
    archive = make_zip(tmp_path / "outer.zip", {
        "source/Thing.zip": inner.getvalue(),
        "textures/albedo.png": b"\x89PNG",
    })
    model, notes = archives.extract_model(archive, tmp_path / "work")
    assert model.name == "Thing.obj"
    # The .mtl has to be a sibling, or Blender cannot resolve materials.
    assert (model.parent / "Thing.mtl").exists()
    assert any("nested" in n for n in notes)


def test_archive_without_a_model_reports_clearly(tmp_path):
    archive = make_zip(tmp_path / "empty.zip", {"readme.txt": b"hi", "a/b.png": b"\x89PNG"})
    with pytest.raises(ArchiveError, match="No convertible model"):
        archives.extract_model(archive, tmp_path / "work")


def test_zip_is_not_itself_treated_as_a_model(tmp_path):
    """A .zip is a supported *upload*, but never the model chosen inside one."""
    inner = io.BytesIO()
    with zipfile.ZipFile(inner, "w") as zf:
        zf.writestr("Thing.obj", b"v 0 0 0\n")
    archive = make_zip(tmp_path / "outer.zip", {"source/Thing.zip": inner.getvalue()})
    model, _ = archives.extract_model(archive, tmp_path / "work")
    assert model.suffix == ".obj"
