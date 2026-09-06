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


def build(parts: list[PartDetail], *, model_file: str, source_name: str) -> dict:
    """The document to write beside a model being exported."""
    return {
        "format": FORMAT,
        "version": VERSION,
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "model": {
            "file": model_file,
            "sourceFile": source_name,
            "parts": len(parts),
        },
        "parts": [p.cleaned() for p in parts[:MAX_PARTS]],
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
