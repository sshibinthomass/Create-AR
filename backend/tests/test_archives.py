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
    with pytest.raises(ArchiveError, match="corrupt or unreadable"):
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
    model = archives.extract_model(archive, tmp_path / "work").model
    assert model.name == "model.glb"  # glb outranks obj outranks stl


def test_shallower_model_wins_over_deeper(tmp_path):
    archive = make_zip(tmp_path / "depth.zip", {
        "deep/nested/model.obj": b"v 0 0 0\n",
        "model.obj": b"v 1 1 1\n",
    })
    model = archives.extract_model(archive, tmp_path / "work").model
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
    found = archives.extract_model(archive, tmp_path / "work")
    model, notes = found.model, found.notes
    assert model.name == "Thing.obj"
    # The .mtl has to be a sibling, or Blender cannot resolve materials.
    assert (model.parent / "Thing.mtl").exists()
    assert any("nested" in n for n in notes)


def test_archive_without_a_model_reports_clearly(tmp_path):
    archive = make_zip(tmp_path / "empty.zip", {"readme.txt": b"hi", "a/b.png": b"\x89PNG"})
    with pytest.raises(ArchiveError, match="No convertible model"):
        archives.extract_model(archive, tmp_path / "work")


def test_collada_archive_names_the_format_and_the_way_out(tmp_path):
    """The Sketchfab "source" download: a real model, in a format we cannot read."""
    archive = make_zip(tmp_path / "chair.zip", {
        "source/model.dae": b"<COLLADA/>",
        "textures/albedo.png": b"\x89PNG",
    })
    with pytest.raises(ArchiveError) as exc:
        archives.extract_model(archive, tmp_path / "work")
    msg = str(exc.value)
    assert "model.dae" in msg
    assert "COLLADA" in msg
    assert "GLB" in msg          # says what to fetch instead
    assert "No convertible model" not in msg   # the vaguer message stays away


def test_unsupported_model_is_found_through_a_nested_archive(tmp_path):
    """The real shape of the bug: the .dae sits inside source/model.zip."""
    inner = io.BytesIO()
    with zipfile.ZipFile(inner, "w") as zf:
        zf.writestr("model/model.dae", b"<COLLADA/>")
    archive = make_zip(tmp_path / "chair.zip", {"source/model.zip": inner.getvalue()})
    with pytest.raises(ArchiveError, match="COLLADA"):
        archives.extract_model(archive, tmp_path / "work")


def test_supported_model_wins_over_an_unsupported_sibling(tmp_path):
    """A .dae beside a .obj is irrelevant -- the .obj converts, no error."""
    archive = make_zip(tmp_path / "both.zip", {
        "source/model.dae": b"<COLLADA/>",
        "Thing.obj": b"v 0 0 0\n",
    })
    found = archives.extract_model(archive, tmp_path / "work")
    assert found.model.name == "Thing.obj"


def test_zip_is_not_itself_treated_as_a_model(tmp_path):
    """A .zip is a supported *upload*, but never the model chosen inside one."""
    inner = io.BytesIO()
    with zipfile.ZipFile(inner, "w") as zf:
        zf.writestr("Thing.obj", b"v 0 0 0\n")
    archive = make_zip(tmp_path / "outer.zip", {"source/Thing.zip": inner.getvalue()})
    model = archives.extract_model(archive, tmp_path / "work").model
    assert model.suffix == ".obj"


# --- container formats -------------------------------------------------------

def _tar(path: Path, entries: dict[str, bytes], mode: str = "w") -> Path:
    import io as _io
    import tarfile
    with tarfile.open(path, mode) as tf:
        for name, data in entries.items():
            info = tarfile.TarInfo(name)
            info.size = len(data)
            tf.addfile(info, _io.BytesIO(data))
    return path


@pytest.mark.parametrize("suffix,mode", [
    (".tar", "w"), (".tar.gz", "w:gz"), (".tar.bz2", "w:bz2"), (".tar.xz", "w:xz"),
])
def test_tar_family_is_unpacked(tmp_path, suffix, mode):
    archive = _tar(tmp_path / f"bundle{suffix}",
                   {"model.obj": b"v 0 0 0\n", "model.mtl": b"newmtl m\n"}, mode)
    model = archives.extract_model(archive, tmp_path / "work").model
    assert model.name == "model.obj"
    assert (model.parent / "model.mtl").exists()


def test_sevenzip_is_unpacked(tmp_path):
    py7zr = pytest.importorskip("py7zr")
    archive = tmp_path / "bundle.7z"
    with py7zr.SevenZipFile(archive, "w") as zf:
        src = tmp_path / "model.obj"
        src.write_bytes(b"v 0 0 0\n")
        zf.write(src, "model.obj")
    model = archives.extract_model(archive, tmp_path / "work").model
    assert model.name == "model.obj"


def test_format_is_detected_from_content_not_extension(tmp_path):
    """A tarball named .zip must still be unpacked."""
    archive = _tar(tmp_path / "mislabelled.zip", {"model.obj": b"v 0 0 0\n"}, "w:gz")
    model = archives.extract_model(archive, tmp_path / "work").model
    assert model.name == "model.obj"


def test_rar_is_reported_as_unsupported(tmp_path):
    bad = tmp_path / "thing.rar"
    bad.write_bytes(b"Rar!\x1a\x07\x00" + b"\x00" * 64)
    with pytest.raises(ArchiveError, match="RAR archives are not supported"):
        archives.safe_extract(bad, tmp_path / "out")


def test_tar_symlink_entries_are_skipped(tmp_path):
    import tarfile
    archive = tmp_path / "links.tar"
    with tarfile.open(archive, "w") as tf:
        link = tarfile.TarInfo("escape")
        link.type = tarfile.SYMTYPE
        link.linkname = "/etc/passwd"
        tf.addfile(link)
        import io as _io
        data = b"v 0 0 0\n"
        info = tarfile.TarInfo("model.obj")
        info.size = len(data)
        tf.addfile(info, _io.BytesIO(data))
    out = tmp_path / "out"
    archives.safe_extract(archive, out)
    assert not (out / "escape").exists()
    assert (out / "model.obj").exists()


# --- arbitrary layouts -------------------------------------------------------

def test_deeply_nested_archives_are_opened(tmp_path):
    """zip inside zip inside zip, with no model until the bottom."""
    innermost = io.BytesIO()
    with zipfile.ZipFile(innermost, "w") as zf:
        zf.writestr("Final.obj", b"v 0 0 0\n")
    mid = io.BytesIO()
    with zipfile.ZipFile(mid, "w") as zf:
        zf.writestr("level3.zip", innermost.getvalue())
    outer = io.BytesIO()
    with zipfile.ZipFile(outer, "w") as zf:
        zf.writestr("level2.zip", mid.getvalue())
    archive = make_zip(tmp_path / "level1.zip", {"nested/level2.zip": outer.getvalue()})

    model = archives.extract_model(archive, tmp_path / "work").model
    assert model.name == "Final.obj"


def test_model_under_an_arbitrary_wrapper_folder(tmp_path):
    """The single-folder wrapper most archives have must not matter."""
    archive = make_zip(tmp_path / "w.zip", {
        "My Model v2 (final)/assets/geo/thing.fbx": b"Kaydara FBX Binary\x00",
        "My Model v2 (final)/readme.txt": b"hi",
    })
    model = archives.extract_model(archive, tmp_path / "work").model
    assert model.name == "thing.fbx"


def test_usdz_inside_an_archive_is_a_model_not_a_container(tmp_path):
    """USDZ is itself a zip; it must never be recursed into."""
    usdz = io.BytesIO()
    with zipfile.ZipFile(usdz, "w") as zf:
        zf.writestr("scene.usdc", b"PXR-USDC")
    archive = make_zip(tmp_path / "outer.zip", {"thing.usdz": usdz.getvalue()})
    found = archives.extract_model(archive, tmp_path / "work")
    assert found.model.name == "thing.usdz"


def test_all_candidates_are_reported(tmp_path):
    archive = make_zip(tmp_path / "many.zip", {
        "a/first.obj": b"v 0 0 0\n",
        "b/second.stl": CUBE_STL.read_bytes(),
        "c/third.ply": b"ply\n",
    })
    found = archives.extract_model(archive, tmp_path / "work")
    assert len(found.candidates) == 3
    assert any("also contains" in n for n in found.notes)


def test_explicit_entry_overrides_the_automatic_pick(tmp_path):
    archive = make_zip(tmp_path / "pick.zip", {
        "preview/low.obj": b"v 0 0 0\n",
        "hero/high.obj": b"v 1 1 1\n",
    })
    found = archives.extract_model(archive, tmp_path / "work", prefer="hero/high.obj")
    assert found.model.name == "high.obj"
    assert found.model.parent.name == "hero"


def test_unknown_entry_lists_the_real_ones(tmp_path):
    archive = make_zip(tmp_path / "pick.zip", {"a.obj": b"v 0 0 0\n"})
    with pytest.raises(ArchiveError, match="not one of the models"):
        archives.extract_model(archive, tmp_path / "work", prefer="nope.obj")
