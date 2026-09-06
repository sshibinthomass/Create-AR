"""The parts document: writing it into a bundle, and recognising one coming back."""

from __future__ import annotations

import json
import os
import zipfile
from pathlib import Path

import pytest

os.environ.setdefault("CONVERTER_DATA_DIR", str(Path(__file__).parent / "_data"))

from app import parts_doc  # noqa: E402
from app.main import Options  # noqa: E402


def detail(index, name, original="", **fields):
    return parts_doc.PartDetail(index=index, name=name, original_name=original,
                                details=fields)


# --- the document itself ------------------------------------------------------

def test_a_document_carries_its_marker_and_every_part():
    doc = parts_doc.build(
        [detail(0, "Front Wheel", "Mesh_001", Purpose="Rolls"),
         detail(1, "Hex Bolt", "Mesh_002")],
        model_file="bike.glb", source_name="bike.fbx",
    )
    assert doc["format"] == parts_doc.FORMAT
    assert doc["model"] == {"file": "bike.glb", "sourceFile": "bike.fbx", "parts": 2}
    assert [p["name"] for p in doc["parts"]] == ["Front Wheel", "Hex Bolt"]
    assert doc["parts"][0]["originalName"] == "Mesh_001"
    assert doc["parts"][0]["details"] == {"Purpose": "Rolls"}


def test_details_keep_whatever_labels_they_came_with():
    """The whole point is that the fields are not a fixed schema."""
    doc = parts_doc.build([detail(
        0, "Bearing",
        **{"What it is": "A sealed ball bearing",
           "Material": "Chrome steel",
           "What usually goes wrong": "The seal perishes"},
    )], model_file="m.glb", source_name="m.glb")
    assert list(doc["parts"][0]["details"]) == [
        "What it is", "Material", "What usually goes wrong"]


def test_a_description_is_tidied_but_not_reshaped():
    kept = parts_doc.clean_details({
        "  Spaced   Label ": "  text   with   gaps  ",
        "Listy": ["one", "two"],
        "Nested": {"no": "objects"},
        "": "no label",
        "No text": "",
    })
    assert kept == {"Spaced Label": "text with gaps", "Listy": "one, two"}


def test_too_many_fields_are_cut_off():
    many = {f"Label {i}": "text" for i in range(parts_doc.MAX_FIELDS + 10)}
    assert len(parts_doc.clean_details(many)) == parts_doc.MAX_FIELDS


# --- reading one back ---------------------------------------------------------

def write_bundle(tmp_path: Path, doc: object, name: str = parts_doc.FILENAME) -> Path:
    root = tmp_path / "unpacked"
    root.mkdir(exist_ok=True)
    (root / name).write_text(json.dumps(doc), encoding="utf-8")
    return root


def test_our_own_document_is_recognised(tmp_path):
    doc = parts_doc.build([detail(0, "Front Wheel", "Mesh_001", Purpose="Rolls")],
                          model_file="bike.glb", source_name="bike.glb")
    found = parts_doc.find(write_bundle(tmp_path, doc))
    assert found is not None
    assert found["parts"][0]["name"] == "Front Wheel"
    assert found["parts"][0]["details"] == {"Purpose": "Rolls"}


def test_somebody_elses_parts_json_is_not_mistaken_for_ours(tmp_path):
    """The marker is the whole point: plenty of pipelines write a parts.json."""
    assert parts_doc.find(write_bundle(tmp_path, {"parts": [{"name": "Wheel"}]})) is None
    assert parts_doc.find(write_bundle(tmp_path, {"format": "something.else",
                                                  "parts": []})) is None


def test_an_archive_without_one_reads_as_nothing(tmp_path):
    root = tmp_path / "empty"
    root.mkdir()
    assert parts_doc.find(root) is None


def test_a_corrupt_document_is_ignored_rather_than_thrown(tmp_path):
    root = tmp_path / "unpacked"
    root.mkdir()
    (root / parts_doc.FILENAME).write_text("{ not json", encoding="utf-8")
    assert parts_doc.find(root) is None


def test_unusable_parts_are_dropped_and_the_rest_kept(tmp_path):
    root = write_bundle(tmp_path, {
        "format": parts_doc.FORMAT,
        "parts": [
            "not an object",
            {"index": 0, "name": "Front Wheel"},
            {"index": 1},                       # no name and no original name
            {"index": "seven", "name": "Hub"},  # unusable index, still a part
        ],
    })
    found = parts_doc.find(root)
    assert [p["name"] for p in found["parts"]] == ["Front Wheel", "Hub"]
    assert found["parts"][1]["index"] == 1      # fell back to its position


def test_a_document_with_no_usable_parts_is_not_a_document(tmp_path):
    assert parts_doc.find(write_bundle(
        tmp_path, {"format": parts_doc.FORMAT, "parts": [{"index": 0}]})) is None


def test_the_shallowest_document_wins(tmp_path):
    """Ours sits at the top of the bundle; a deeper one is somebody else's."""
    root = tmp_path / "unpacked"
    (root / "vendor" / "deep").mkdir(parents=True)
    ours = parts_doc.build([detail(0, "Ours")], model_file="m.glb", source_name="m.glb")
    theirs = parts_doc.build([detail(0, "Theirs")], model_file="x.glb", source_name="x.glb")
    (root / parts_doc.FILENAME).write_text(json.dumps(ours), encoding="utf-8")
    (root / "vendor" / "deep" / parts_doc.FILENAME).write_text(
        json.dumps(theirs), encoding="utf-8")
    assert parts_doc.find(root)["parts"][0]["name"] == "Ours"


def test_an_enormous_document_is_skipped(tmp_path):
    root = tmp_path / "unpacked"
    root.mkdir()
    padding = "x" * (parts_doc.MAX_DOC_BYTES + 1)
    (root / parts_doc.FILENAME).write_text(
        json.dumps({"format": parts_doc.FORMAT, "pad": padding,
                    "parts": [{"index": 0, "name": "Wheel"}]}),
        encoding="utf-8")
    assert parts_doc.find(root) is None


# --- the conversion option ----------------------------------------------------

def test_a_bundle_is_off_unless_asked_for():
    assert Options().bundle is False
    assert Options().part_details == []


def test_details_ride_along_with_the_conversion_options():
    opts = Options(bundle=True, part_details=[
        {"index": 0, "name": "Front Wheel", "original_name": "Mesh_001",
         "details": {"Purpose": "Rolls"}},
    ])
    assert opts.bundle is True
    assert opts.part_details[0].name == "Front Wheel"
    # model_dump has to survive the trip to the worker as plain data.
    assert opts.model_dump()["part_details"][0]["details"] == {"Purpose": "Rolls"}


def test_more_parts_than_a_document_holds_is_rejected():
    with pytest.raises(Exception):
        Options(part_details=[{"index": i, "name": f"P{i}"}
                              for i in range(parts_doc.MAX_PARTS + 1)])


def test_a_written_bundle_is_a_zip_holding_the_model_and_the_document(tmp_path):
    """What `convert` assembles, assembled the same way here."""
    out = tmp_path / "out"
    out.mkdir()
    (out / "bike.glb").write_bytes(b"glTF-ish")
    doc = parts_doc.build([detail(0, "Front Wheel")],
                          model_file="bike.glb", source_name="bike.glb")
    parts_doc.write(doc, out)

    archive = tmp_path / "bundle.zip"
    with zipfile.ZipFile(archive, "w") as zf:
        for f in sorted(out.rglob("*")):
            zf.write(f, f.relative_to(out).as_posix())

    with zipfile.ZipFile(archive) as zf:
        assert sorted(zf.namelist()) == ["bike.glb", "parts.json"]
        back = json.loads(zf.read("parts.json"))
    assert back["format"] == parts_doc.FORMAT
    assert back["parts"][0]["name"] == "Front Wheel"


def test_a_part_survives_being_read_out_of_a_bundle_and_handed_straight_back():
    """The document writes originalName; the options around it are snake_case.

    Both spellings have to land on the same field, or a round trip silently
    loses the original name -- which is one of the two keys the re-import
    matches parts on.
    """
    from_doc = parts_doc.PartDetail(index=0, name="Hub", originalName="Mesh_1")
    from_options = parts_doc.PartDetail(index=0, name="Hub", original_name="Mesh_1")
    assert from_doc.original_name == from_options.original_name == "Mesh_1"
    assert from_doc.cleaned()["originalName"] == "Mesh_1"


def test_the_browser_sends_a_document_shaped_part_and_it_arrives_whole():
    opts = Options(bundle=True, part_details=[
        {"index": 0, "originalName": "Mesh_001", "name": "Front Wheel",
         "details": {"Purpose": "Rolls"}},
    ])
    doc = parts_doc.build(opts.part_details, model_file="m.glb", source_name="m.fbx")
    assert doc["parts"][0] == {
        "index": 0, "originalName": "Mesh_001", "name": "Front Wheel",
        "details": {"Purpose": "Rolls"},
    }
