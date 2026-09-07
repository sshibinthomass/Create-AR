"""The parts document: what each piece of a model is, written beside it.

A model file carries names and geometry and nothing else -- there is nowhere in
glTF, USD or FBX to say what a part is *for*. So the descriptions travel in a
JSON file next to the model, and the two are zipped together.

The `format` marker at the top is how the app recognises its own bundle when one
is uploaded again: finding it means the names and the descriptions can be put
back on the parts they belong to, instead of the user starting over.

Nothing here assumes which fields a description has. `details` is an ordered map
of label to text, whatever labels the model chose -- what a bearing is worth
saying about differs from what a wiring loom is worth saying about, and a fixed
schema would either cramp one or pad the other.

The animations travel the same way and for the same reason. A glTF animation is
a name and some curves; there is nowhere in it to say that this one raises the
seat by a fifth of the chair's height, or that a question about how tall the
chair goes should be answered with it. So each clip's meaning is written here,
indexed by where the clip sits in the file's animation list, beside the parts it
moves. Read the two sections together and the file describes both what the thing
is made of and what it does.
"""

from __future__ import annotations

import json
import struct
import time
from pathlib import Path

from pydantic import BaseModel, ConfigDict, Field

FORMAT = "create-ar.parts"
# 2 added the "animations" section. A version 1 document is still perfectly
# readable -- it simply describes a model that had no animations described.
VERSION = 2
FILENAME = "parts.json"

MAX_PARTS = 500
MAX_NAME_LEN = 120
MAX_FIELDS = 16
MAX_LABEL_LEN = 60
MAX_TEXT_LEN = 2000
MAX_ANIMATIONS = 500
MAX_SUMMARY_LEN = 600
MAX_TAGS = 32
# A whole document, on the way back in. Generous next to 500 parts of prose,
# tight enough that a hostile zip cannot make the server chew through a gigabyte.
MAX_DOC_BYTES = 4 * 1024 * 1024


def clean_details(raw: object) -> dict[str, str]:
    """Keep a description's labelled fields, whatever they turned out to be.

    Two shapes are accepted. A plain object of label to text is what the
    document stores and what a model usually volunteers; a list of
    ``{"label": ..., "text": ...}`` pairs is what the models are *asked* for,
    because an object with open keys cannot be written as a strict JSON schema
    and so cannot be enforced on the providers that support one.
    """
    if isinstance(raw, (list, tuple)):
        raw = {pair.get("label"): pair.get("text")
               for pair in raw if isinstance(pair, dict)}
    if not isinstance(raw, dict):
        return {}
    out: dict[str, str] = {}
    for label, text in raw.items():
        if len(out) >= MAX_FIELDS:
            break
        label = " ".join(str(label).split())[:MAX_LABEL_LEN]
        # Anything scalar is worth keeping; a nested object is not a description.
        if isinstance(text, (list, tuple)):
            text = ", ".join(str(t) for t in text)
        elif isinstance(text, dict):
            continue
        text = " ".join(str(text).split())[:MAX_TEXT_LEN]
        if label and text:
            out[label] = text
    return out


class PartDetail(BaseModel):
    """One part, as the browser knows it by the time the model is saved.

    Accepts either spelling of the original name. The document writes
    ``originalName``, because that is the convention for the JSON people read;
    the conversion options around it are snake_case like every other option. A
    part therefore survives being read out of a bundle and handed straight back.
    """

    model_config = ConfigDict(populate_by_name=True)

    index: int = Field(ge=0)
    # What the part is called in the file the app was given.
    original_name: str = Field("", max_length=MAX_NAME_LEN, alias="originalName")
    # What it is called in the file being written, which may be the same.
    name: str = Field("", max_length=MAX_NAME_LEN)
    details: dict[str, str] = Field(default_factory=dict)

    def cleaned(self) -> dict:
        return {
            "index": self.index,
            "originalName": " ".join(self.original_name.split())[:MAX_NAME_LEN],
            "name": " ".join(self.name.split())[:MAX_NAME_LEN],
            "details": clean_details(self.details),
        }


class AnimationDetail(BaseModel):
    """One animation, as the browser worked out what it means.

    The clip itself is in the model file. This is the half a file cannot hold:
    which parts move, which way, how far, and a sentence saying so. ``name`` is
    what a reader should join on -- it is written into the file as the
    animation's own name and survives whatever the exporter does to the order.

    Nothing here is derived from the file. It is what the generator decided when
    it built the clip, carried through unchanged, so a description that has
    drifted from the motion means the generator drifted, not the document.
    """

    model_config = ConfigDict(populate_by_name=True)

    index: int = Field(0, ge=0)
    name: str = Field("", max_length=MAX_NAME_LEN)
    duration: float = 0.0
    # Which of the generator's motions this is: "raise", "spin", "detach"...
    # Free text rather than an enumeration, because the document outlives any
    # particular list of motions and a reader that meets an unknown one should
    # fall back to the summary rather than reject the file.
    kind: str = Field("", max_length=32)
    targets: list[str] = Field(default_factory=list)
    labels: list[str] = Field(default_factory=list)
    axis: str = Field("", max_length=1)
    amount: float = 0.0
    summary: str = Field("", max_length=MAX_SUMMARY_LEN)
    tags: list[str] = Field(default_factory=list)

    def cleaned(self) -> dict:
        trim = lambda values: [  # noqa: E731 -- one expression, used twice
            " ".join(str(v).split())[:MAX_NAME_LEN] for v in values[:MAX_PARTS]]
        return {
            "index": self.index,
            "name": " ".join(self.name.split())[:MAX_NAME_LEN],
            "duration": round(float(self.duration), 3),
            "kind": " ".join(self.kind.split())[:32],
            "targets": trim(self.targets),
            "labels": trim(self.labels),
            "axis": self.axis if self.axis in ("x", "y", "z") else "",
            "amount": round(float(self.amount), 4),
            "summary": " ".join(self.summary.split())[:MAX_SUMMARY_LEN],
            "tags": trim(self.tags)[:MAX_TAGS],
        }


def clean_animations(raw: object) -> list[dict]:
    """An ``animations`` section read back out of a document, or an empty list."""
    if not isinstance(raw, list):
        return []
    out: list[dict] = []
    for entry in raw[:MAX_ANIMATIONS]:
        if not isinstance(entry, dict):
            continue
        try:
            out.append(AnimationDetail(**entry).cleaned())
        except (TypeError, ValueError):
            continue
    return out


# glTF's magic, and the tag on its JSON chunk. Only the first chunk is read:
# it holds the whole node graph, and the buffer after it can be a hundred
# megabytes that nothing here needs.
_GLB_MAGIC = 0x46546C67
_GLB_JSON = 0x4E4F534A
# A node graph big enough for any real assembly; a header claiming more than
# this is not one we should be allocating for.
MAX_GLTF_JSON = 64 * 1024 * 1024


def _gltf_json(path: Path) -> dict | None:
    """The glTF document inside a .gltf or .glb, or None if it is neither."""
    suffix = path.suffix.lower()
    try:
        if suffix == ".gltf":
            if path.stat().st_size > MAX_GLTF_JSON:
                return None
            found = json.loads(path.read_text("utf-8"))
        elif suffix == ".glb":
            with path.open("rb") as handle:
                magic, _version, _length = struct.unpack("<III", handle.read(12))
                if magic != _GLB_MAGIC:
                    return None
                size, kind = struct.unpack("<II", handle.read(8))
                if kind != _GLB_JSON or size > MAX_GLTF_JSON:
                    return None
                found = json.loads(handle.read(size).decode("utf-8"))
        else:
            return None
    except (OSError, ValueError, struct.error, UnicodeDecodeError):
        return None
    return found if isinstance(found, dict) else None


def _draws(index: int, nodes: list, seen: set[int] | None = None) -> bool:
    """Does this node, or anything under it, actually draw something?"""
    seen = seen if seen is not None else set()
    if index in seen or not 0 <= index < len(nodes):
        return False
    seen.add(index)
    node = nodes[index]
    if not isinstance(node, dict):
        return False
    if "mesh" in node:
        return True
    return any(_draws(child, nodes, seen) for child in node.get("children") or [])


def export_order(path: Path) -> list[str]:
    """The part names in the order the written file actually lists them.

    Which is *not* the order they were sent in. Renaming happens in Blender by
    object name, which is correct, but the glTF exporter walks
    ``bpy.data.objects`` -- a collection Blender keeps sorted alphabetically --
    so renaming a model reorders it. Anything keyed on position would then point
    at the wrong part in the file it was written beside.

    The descent through single-child wrappers matches ``partNodes`` in
    frontend/src/partGraph.ts, so the browser and the document agree on which
    nodes are parts. An empty list means the format carries no readable node
    order, and the indices are left as they were sent.
    """
    found = _gltf_json(path)
    if not found:
        return []
    nodes = found.get("nodes")
    scenes = found.get("scenes")
    if not isinstance(nodes, list) or not isinstance(scenes, list) or not scenes:
        return []
    at = found.get("scene", 0)
    if not isinstance(at, int) or not 0 <= at < len(scenes):
        at = 0
    scene = scenes[at]
    roots = scene.get("nodes") if isinstance(scene, dict) else None
    if not isinstance(roots, list):
        return []

    level = [i for i in roots if isinstance(i, int) and _draws(i, nodes)]
    while len(level) == 1 and (nodes[level[0]] or {}).get("children"):
        deeper = [i for i in nodes[level[0]]["children"]
                  if isinstance(i, int) and _draws(i, nodes)]
        if not deeper:
            break
        level = deeper
    if len(level) < 2:
        return []
    return [str((nodes[i] or {}).get("name") or "") for i in level]


def animation_order(path: Path) -> list[str]:
    """The animation names in the order the written file lists them.

    The same problem ``export_order`` solves for parts, and for the same reason:
    Blender's glTF exporter walks its own collections, not the order the clips
    arrived in, so a document that numbered them as sent would point a reader at
    the wrong animation. An empty list means the format carries no readable
    animation list, and the numbers are left as they were sent.
    """
    found = _gltf_json(path)
    clips = (found or {}).get("animations")
    if not isinstance(clips, list):
        return []
    return [str((clip or {}).get("name") or "") for clip in clips
            if isinstance(clip, dict)]


def renumbered(entries: list[dict], order: list[str]) -> tuple[list[dict], bool]:
    """Point every entry's index at where it really sits in the written file.

    Used for both sections, which have the same problem: the exporter does not
    preserve the order things were sent in, and both a part and an animation
    carry a ``name`` that survives the export.

    All or nothing: a partial renumber would leave the document half describing
    one order and half another, which is worse than describing the order it was
    given. So unless every entry is found in the written file, the indices are
    left alone and the document says they were not confirmed.
    """
    if not order:
        return entries, False
    at = {}
    for position, name in enumerate(order):
        at.setdefault(name, position)
    if any(entry["name"] not in at for entry in entries):
        return entries, False
    return [{**entry, "index": at[entry["name"]]} for entry in entries], True


def build(parts: list[PartDetail], *, model_file: str, source_name: str,
          written: Path | None = None,
          animations: list[AnimationDetail] | None = None) -> dict:
    """The document to write beside a model being exported.

    ``written`` is the exported file itself. When it is a glTF both orders are
    read back out of it, because the export preserves neither the order the
    parts were sent in nor the order the clips were -- see ``export_order`` and
    ``animation_order``.

    ``animations`` describes only the clips that were actually written. A clip
    keyed by hand has nothing to say about itself and is simply absent, which is
    why the count in ``model`` is the number described rather than the number in
    the file.
    """
    cleaned = [p.cleaned() for p in parts[:MAX_PARTS]]
    confirmed = False
    clips = [a.cleaned() for a in (animations or [])[:MAX_ANIMATIONS]]
    clips_confirmed = False
    if written is not None and written.exists():
        cleaned, confirmed = renumbered(cleaned, export_order(written))
        if clips:
            clips, clips_confirmed = renumbered(clips, animation_order(written))
    return {
        "format": FORMAT,
        "version": VERSION,
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "model": {
            "file": model_file,
            "sourceFile": source_name,
            "parts": len(parts),
            "animations": len(clips),
            # Whether "index" was checked against the file beside this document
            # or is only the order the parts were sent in. A reader that needs
            # certainty should join on "originalName", which survives either way.
            "indexMatchesFile": confirmed,
            # The same question for the animations, which join on "name".
            "animationIndexMatchesFile": clips_confirmed,
        },
        "parts": cleaned,
        "animations": clips,
    }


def _validate(raw: object) -> dict | None:
    """Accept a document only if it is ours and its parts are usable."""
    if not isinstance(raw, dict) or raw.get("format") != FORMAT:
        return None
    parts = raw.get("parts")
    if not isinstance(parts, list):
        return None

    kept: list[dict] = []
    for entry in parts[:MAX_PARTS]:
        if not isinstance(entry, dict):
            continue
        name = " ".join(str(entry.get("name", "")).split())[:MAX_NAME_LEN]
        original = " ".join(str(entry.get("originalName", "")).split())[:MAX_NAME_LEN]
        if not name and not original:
            continue
        try:
            index = int(entry.get("index", len(kept)))
        except (TypeError, ValueError):
            index = len(kept)
        kept.append({
            "index": max(0, index),
            "originalName": original,
            "name": name,
            "details": clean_details(entry.get("details")),
        })

    if not kept:
        return None
    model = raw.get("model")
    return {
        "format": FORMAT,
        "version": raw.get("version", VERSION),
        "generatedAt": str(raw.get("generatedAt", ""))[:40],
        "model": model if isinstance(model, dict) else {},
        "parts": kept,
        # Absent on a version 1 document, which described no animations. An
        # empty list rather than a missing key, so a reader never has to ask
        # which kind of document it is holding.
        "animations": clean_animations(raw.get("animations")),
    }


def find(root: Path) -> dict | None:
    """Look for our document in an unpacked archive. Returns None if it is not ours.

    Shallowest first: a bundle written by this app has it at the top level, and
    a deeper file of the same name is more likely to belong to something else.
    """
    candidates = sorted(
        (p for p in root.rglob(FILENAME) if p.is_file()),
        key=lambda p: len(p.relative_to(root).parts),
    )
    for path in candidates[:8]:
        try:
            if path.stat().st_size > MAX_DOC_BYTES:
                continue
            found = _validate(json.loads(path.read_text("utf-8")))
        except (OSError, json.JSONDecodeError, UnicodeDecodeError):
            continue
        if found is not None:
            return found
    return None


def write(doc: dict, into: Path) -> Path:
    path = into / FILENAME
    path.write_text(json.dumps(doc, indent=2, ensure_ascii=False), encoding="utf-8")
    return path
