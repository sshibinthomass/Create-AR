"""The parts document: writing it into a bundle, and recognising one coming back."""

from __future__ import annotations

import json
import os
import struct
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
    assert doc["model"] == {"file": "bike.glb", "sourceFile": "bike.fbx",
                            "parts": 2, "animations": 0,
                            "indexMatchesFile": False,
                            "animationIndexMatchesFile": False}
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


# --- the order the file actually ends up in -----------------------------------
#
# Renaming a model reorders it. Blender renames by object name, which is right,
# but its glTF exporter walks bpy.data.objects -- kept sorted alphabetically --
# so the parts come out in the order of their *new* names. A document numbered
# from the order they were sent in would point at the wrong parts.

def gltf(names, *, wrapper=True):
    """A glTF document whose parts are `names`, in that order."""
    nodes = []
    parts = []
    for name in names:
        mesh_at = len(nodes)
        nodes.append({"name": f"{name}_mesh", "mesh": 0})
        parts.append(len(nodes))
        nodes.append({"name": name, "children": [mesh_at]})
    if wrapper:
        roots = [len(nodes)]
        nodes.append({"name": "Scene wrapper", "children": parts})
    else:
        roots = parts
    return {"asset": {"version": "2.0"}, "scene": 0,
            "scenes": [{"nodes": roots}], "nodes": nodes,
            "meshes": [{"primitives": []}]}


def write_glb(path: Path, document: dict) -> Path:
    body = json.dumps(document).encode("utf-8")
    body += b" " * (-len(body) % 4)
    path.write_bytes(
        struct.pack("<III", 0x46546C67, 2, 12 + 8 + len(body))
        + struct.pack("<II", len(body), 0x4E4F534A) + body)
    return path


def test_the_order_is_read_out_of_a_written_glb(tmp_path):
    written = write_glb(tmp_path / "m.glb", gltf(["Seat", "Base", "Castor"]))
    assert parts_doc.export_order(written) == ["Seat", "Base", "Castor"]


def test_a_gltf_reads_the_same_way(tmp_path):
    path = tmp_path / "m.gltf"
    path.write_text(json.dumps(gltf(["Seat", "Base"])), encoding="utf-8")
    assert parts_doc.export_order(path) == ["Seat", "Base"]


def test_wrappers_are_descended_the_way_the_viewer_descends_them(tmp_path):
    """The browser and the document have to agree on which nodes are parts."""
    flat = write_glb(tmp_path / "a.glb", gltf(["Seat", "Base"], wrapper=False))
    assert parts_doc.export_order(flat) == ["Seat", "Base"]


def test_a_format_with_no_readable_order_leaves_the_indices_alone(tmp_path):
    path = tmp_path / "m.fbx"
    path.write_bytes(b"not a gltf")
    assert parts_doc.export_order(path) == []


def test_a_truncated_glb_is_ignored_rather_than_thrown(tmp_path):
    path = tmp_path / "m.glb"
    path.write_bytes(b"glTF" + bytes(6))
    assert parts_doc.export_order(path) == []


def test_a_single_part_model_has_no_order_worth_recording(tmp_path):
    """The viewer treats a lone drawable as no parts at all; so does this."""
    written = write_glb(tmp_path / "m.glb", gltf(["Only"]))
    assert parts_doc.export_order(written) == []


def test_the_indices_are_moved_to_where_the_parts_really_are(tmp_path):
    written = write_glb(tmp_path / "m.glb", gltf(["Base", "Castor", "Seat"]))
    doc = parts_doc.build(
        [detail(0, "Seat", "Mesh_001"), detail(1, "Base", "Mesh_002"),
         detail(2, "Castor", "Mesh_003")],
        model_file="m.glb", source_name="m.fbx", written=written)

    assert doc["model"]["indexMatchesFile"] is True
    assert {p["name"]: p["index"] for p in doc["parts"]} == {
        "Base": 0, "Castor": 1, "Seat": 2}
    # The original names are untouched: they are what a reader joins on when the
    # index cannot be trusted.
    assert {p["name"]: p["originalName"] for p in doc["parts"]} == {
        "Seat": "Mesh_001", "Base": "Mesh_002", "Castor": "Mesh_003"}


def test_a_part_missing_from_the_file_leaves_every_index_as_it_was(tmp_path):
    """Half one order and half another would be worse than one honest order."""
    written = write_glb(tmp_path / "m.glb", gltf(["Base", "Castor"]))
    doc = parts_doc.build(
        [detail(0, "Seat"), detail(1, "Base"), detail(2, "Castor")],
        model_file="m.glb", source_name="m.fbx", written=written)

    assert doc["model"]["indexMatchesFile"] is False
    assert [p["index"] for p in doc["parts"]] == [0, 1, 2]


def test_a_document_written_without_the_file_says_so():
    doc = parts_doc.build([detail(0, "Seat"), detail(1, "Base")],
                          model_file="m.glb", source_name="m.fbx")
    assert doc["model"]["indexMatchesFile"] is False


# --- the animations -----------------------------------------------------------
#
# A glTF animation is a name and some curves. What it *does* -- which parts, how
# far, along which axis -- has nowhere to live in the file, so it lives here,
# beside the parts, for whatever later reads the bundle to answer questions with.

def motion(name, **fields):
    return parts_doc.AnimationDetail(name=name, **fields)


def test_an_animation_is_described_beside_the_parts_it_moves():
    doc = parts_doc.build(
        [detail(0, "Seat plate")],
        model_file="chair.glb", source_name="chair.fbx",
        animations=[motion("Raise the seat plate", duration=2.5, kind="raise",
                           targets=["Mesh_001"], labels=["Seat plate"],
                           axis="y", amount=0.21,
                           summary="Lifts the seat plate 0.21 straight up.",
                           tags=["height", "adjust"])],
    )
    assert doc["model"]["animations"] == 1
    assert doc["animations"][0] == {
        "index": 0, "name": "Raise the seat plate", "duration": 2.5,
        "kind": "raise", "targets": ["Mesh_001"], "labels": ["Seat plate"],
        "axis": "y", "amount": 0.21,
        "summary": "Lifts the seat plate 0.21 straight up.",
        "tags": ["height", "adjust"],
    }


def test_a_model_with_no_animations_still_has_the_section():
    """An empty list, not a missing key: a reader should never have to ask."""
    doc = parts_doc.build([detail(0, "Seat")], model_file="m.glb", source_name="m.glb")
    assert doc["animations"] == []
    assert doc["model"]["animations"] == 0


def test_an_axis_that_is_not_an_axis_is_dropped():
    made = motion("Wobble", axis="w").cleaned()
    assert made["axis"] == ""


def gltf_with_clips(names, clips):
    document = gltf(names)
    document["animations"] = [{"name": name, "channels": [], "samplers": []}
                              for name in clips]
    return document


def test_the_animation_indices_are_moved_to_where_the_clips_really_are(tmp_path):
    """The exporter reorders the clips exactly as it reorders the parts."""
    written = write_glb(tmp_path / "m.glb", gltf_with_clips(
        ["Base", "Seat"], ["Show the seat", "Raise the seat", "Spin the base"]))
    doc = parts_doc.build(
        [detail(0, "Base"), detail(1, "Seat")],
        model_file="m.glb", source_name="m.fbx", written=written,
        animations=[motion("Raise the seat"), motion("Spin the base"),
                    motion("Show the seat")])

    assert doc["model"]["animationIndexMatchesFile"] is True
    assert {a["name"]: a["index"] for a in doc["animations"]} == {
        "Show the seat": 0, "Raise the seat": 1, "Spin the base": 2}


def test_a_clip_missing_from_the_file_leaves_every_animation_index_alone(tmp_path):
    written = write_glb(tmp_path / "m.glb",
                        gltf_with_clips(["Base", "Seat"], ["Raise the seat"]))
    doc = parts_doc.build(
        [detail(0, "Base"), detail(1, "Seat")],
        model_file="m.glb", source_name="m.fbx", written=written,
        animations=[motion("Raise the seat", index=0),
                    motion("Spin the base", index=1)])

    assert doc["model"]["animationIndexMatchesFile"] is False
    assert [a["index"] for a in doc["animations"]] == [0, 1]


def test_a_version_one_document_reads_back_as_one_with_no_animations(tmp_path):
    root = tmp_path / "old"
    root.mkdir()
    (root / parts_doc.FILENAME).write_text(json.dumps({
        "format": parts_doc.FORMAT, "version": 1,
        "parts": [{"index": 0, "name": "Seat"}],
    }), encoding="utf-8")
    found = parts_doc.find(root)
    assert found is not None
    assert found["animations"] == []


def test_a_document_carrying_animations_reads_them_back(tmp_path):
    root = tmp_path / "bundle"
    root.mkdir()
    doc = parts_doc.build(
        [detail(0, "Seat")], model_file="m.glb", source_name="m.glb",
        animations=[motion("Raise the seat", kind="raise", axis="y", amount=0.2,
                           tags=["height"])])
    parts_doc.write(doc, root)
    back = parts_doc.find(root)
    assert back is not None
    assert back["animations"][0]["kind"] == "raise"
    assert back["animations"][0]["tags"] == ["height"]


def test_rubbish_in_the_animation_list_is_skipped_not_fatal():
    kept = parts_doc.clean_animations(
        ["not an object", {"name": "Raise the seat", "kind": "raise"}, 7])
    assert [a["name"] for a in kept] == ["Raise the seat"]


# --- the animations, as the conversion option carries them --------------------

def test_a_clip_can_say_what_it_means():
    from app.main import Clip
    clip = Clip(name="Raise the seat", duration=2.5,
                tracks=[{"target": "Seat", "keys": [{"time": 0}, {"time": 2.5}]}],
                meta={"kind": "raise", "targets": ["Seat"], "labels": ["Seat"],
                      "axis": "y", "amount": 0.2,
                      "summary": "Lifts the seat.", "tags": ["Height", " height "]})
    assert clip.meta is not None
    assert clip.meta.kind == "raise"
    # Tags are lowercased and deduplicated: they exist to be matched against.
    assert clip.meta.tags == ["height"]


def test_a_clip_keyed_by_hand_says_nothing_about_itself():
    from app.main import Clip
    clip = Clip(name="Animation 1",
                tracks=[{"target": "Seat", "keys": [{"time": 0}]}])
    assert clip.meta is None


def test_a_generated_run_of_animations_is_not_too_many_to_send():
    """A forty-part assembly generates well over a hundred clips."""
    opts = Options(clips=[
        {"name": f"Clip {i}", "duration": 2.5,
         "tracks": [{"target": f"Part {i}", "keys": [{"time": 0}, {"time": 2.5}]}]}
        for i in range(200)])
    assert len(opts.clips) == 200

