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
"""

from __future__ import annotations

import json
import struct
import time
from pathlib import Path

from pydantic import BaseModel, ConfigDict, Field

FORMAT = "create-ar.parts"
VERSION = 1
FILENAME = "parts.json"

MAX_PARTS = 500
MAX_NAME_LEN = 120
MAX_FIELDS = 16
MAX_LABEL_LEN = 60
MAX_TEXT_LEN = 2000
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


def renumbered(parts: list[dict], order: list[str]) -> tuple[list[dict], bool]:
    """Point every entry's index at where that part really sits in the file.

    All or nothing: a partial renumber would leave the document half describing
    one order and half another, which is worse than describing the order it was
    given. So unless every part is found exactly once in the written file, the
    indices are left alone and the document says they were not confirmed.
    """
    if not order:
        return parts, False
    at = {}
    for position, name in enumerate(order):
        at.setdefault(name, position)
    if any(part["name"] not in at for part in parts):
        return parts, False
    return [{**part, "index": at[part["name"]]} for part in parts], True


def build(parts: list[PartDetail], *, model_file: str, source_name: str,
          written: Path | None = None) -> dict:
    """The document to write beside a model being exported.

    ``written`` is the exported file itself. When it is a glTF the part order is
    read back out of it, because the export does not preserve the order the
    parts were sent in -- see ``export_order``.
    """
    cleaned = [p.cleaned() for p in parts[:MAX_PARTS]]
    confirmed = False
    if written is not None and written.exists():
        cleaned, confirmed = renumbered(cleaned, export_order(written))
    return {
        "format": FORMAT,
        "version": VERSION,
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "model": {
            "file": model_file,
            "sourceFile": source_name,
            "parts": len(parts),
            # Whether "index" was checked against the file beside this document
            # or is only the order the parts were sent in. A reader that needs
            # certainty should join on "originalName", which survives either way.
            "indexMatchesFile": confirmed,
        },
        "parts": cleaned,
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
