"""Ask an Azure OpenAI vision deployment what each part of a model is.

The browser renders the pictures -- it already has the model loaded in WebGL,
so a part can be framed and shot in a few milliseconds, where a second Blender
pass would cost a process launch per part. This module only carries them across
and reads the answer back.

One call handles one *chunk* of parts: a single part when the user has asked for
a request each, or several when they have asked for batches. The browser decides
how the chunks are cut and how many are in flight, which is what lets names
appear in the list as they arrive rather than all at the end.
"""

from __future__ import annotations

import json

from pydantic import BaseModel, Field

from . import parts_doc
from .settings import Settings

# A hard ceiling on one request, whatever the batch size says. Accuracy falls
# away long before this; it is here so a malformed request cannot ask for a
# hundred images at once.
MAX_PARTS_PER_CALL = 24
# base64 of a 512x512 JPEG runs to about 40 KB; this leaves room to spare.
MAX_IMAGE_CHARS = 1_500_000
# Long enough for any real name. main.py's rename validator does the
# authoritative cleaning when the model is saved -- the same one that handles
# names typed by hand -- so this only keeps the list readable.
MAX_NAME_LEN = 120


class NamingError(RuntimeError):
    """The deployment could not be reached, or did not answer usefully."""


class PartShot(BaseModel):
    """One part, as rendered by the viewer. Images are base64 JPEG, no prefix."""

    index: int = Field(ge=0)
    # What the file calls it. Sent as a hint, not as something to preserve.
    name: str = Field("", max_length=MAX_NAME_LEN)
    isolated: str = Field(max_length=MAX_IMAGE_CHARS)
    context: str = Field("", max_length=MAX_IMAGE_CHARS)


class NameRequest(BaseModel):
    parts: list[PartShot] = Field(min_length=1, max_length=MAX_PARTS_PER_CALL)
    # How many parts the whole model has, so a chunk can say where it sits.
    total: int = Field(1, ge=1)
    # Names already handed out for this model, so the reply can avoid repeating
    # them. Best effort: with several requests in flight the list is a snapshot.
    taken: list[str] = Field(default_factory=list, max_length=500)
    # Ask for a description of each part too, not just a name. The setting is
    # the default; the browser sends it so a single run cannot disagree with
    # what the user saw on the button.
    describe: bool = False


def _image(data: str) -> dict:
    return {"type": "image_url",
            "image_url": {"url": f"data:image/jpeg;base64,{data}"}}


def _anthropic_image(data: str) -> dict:
    return {"type": "image",
            "source": {"type": "base64", "media_type": "image/jpeg", "data": data}}


def reply_schema(describe: bool) -> dict:
    """The shape a reply has to take.

    Anthropic is handed this to enforce; the OpenAI-shaped providers are only
    asked for "an object", because a deployment there may be any model at all
    and json_schema support is far from universal.

    Descriptions are a list of label/text pairs rather than an object keyed by
    label, because a strict schema cannot describe an object whose keys are not
    known in advance -- and the whole point of the labels is that the model
    picks them. They are folded back into a plain object for the document.
    """
    part = {
        "type": "object",
        "properties": {"id": {"type": "integer"}, "name": {"type": "string"}},
        "required": ["id", "name"],
        "additionalProperties": False,
    }
    if describe:
        part["properties"]["details"] = {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {"label": {"type": "string"},
                               "text": {"type": "string"}},
                "required": ["label", "text"],
                "additionalProperties": False,
            },
        }
        part["required"] = ["id", "name", "details"]
    return {
        "type": "object",
        "properties": {"parts": {"type": "array", "items": part}},
        "required": ["parts"],
        "additionalProperties": False,
    }


def _blocks(req: NameRequest, image=_image) -> list[dict]:
    """The user turn: every part's pictures, then what to reply with.

    Only the image block differs between providers, so the wording -- which is
    the part that decides how good the names are -- stays in one place.
    """
    out: list[dict] = []
    for part in req.parts:
        line = f"Part id {part.index}, one of {req.total} in this model"
        if part.name:
            line += f', called "{part.name}" in the file'
        out.append({"type": "text", "text": f"{line}. On its own:"})
        out.append(image(part.isolated))
        if part.context:
            out.append({"type": "text",
                        "text": "The same part, highlighted in orange in the "
                                "whole assembly:"})
            out.append(image(part.context))

    if req.taken:
        out.append({"type": "text", "text":
                    "Names already given to other parts of this model. Do not "
                    "repeat one unless this part really is a duplicate, in "
                    "which case number them: " + ", ".join(req.taken)})

    ids = ", ".join(str(p.index) for p in req.parts)
    shape = ('{"parts": [{"id": <id>, "name": "<name>", "details": '
             '[{"label": "<label>", "text": "<text>"}]}]}') if req.describe else (
            '{"parts": [{"id": <id>, "name": "<name>"}]}')
    out.append({"type": "text", "text":
                f"Reply with JSON and nothing else, in the form {shape}, with "
                f"exactly one entry for each of these ids: {ids}."})
    return out


def _clean(value: object) -> str:
    name = " ".join(str(value).split())[:MAX_NAME_LEN]
    return "".join(ch for ch in name if ch.isprintable())


def _read(reply: str | None, req: NameRequest) -> dict[int, dict]:
    """Pull the names -- and descriptions -- out of the reply.

    Only the ids this chunk actually asked about are kept, so a model that
    volunteers an extra part cannot write over one another request is naming.
    """
    try:
        body = json.loads(reply or "")
    except json.JSONDecodeError as exc:
        raise NamingError("The model did not reply with JSON.") from exc

    entries = body.get("parts") if isinstance(body, dict) else body
    if not isinstance(entries, list):
        raise NamingError("The model's reply had no list of parts in it.")

    wanted = {p.index for p in req.parts}
    named: dict[int, dict] = {}
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        try:
            index = int(entry.get("id"))
        except (TypeError, ValueError):
            continue
        name = _clean(entry.get("name", ""))
        if index in wanted and name:
            named[index] = {
                "name": name,
                # Whatever labels the model chose, cleaned but not cut to a
                # fixed schema -- see parts_doc for why they are left open.
                "details": parts_doc.clean_details(entry.get("details"))
                if req.describe else {},
            }
    if not named:
        raise NamingError("The model named none of the parts it was sent.")
    return named


def _budget(req: NameRequest) -> int:
    """Room for the reply. A name is a few words; a description is paragraphs."""
    return 200 + (900 if req.describe else 80) * len(req.parts)


def _ask_openai(req: NameRequest, settings: Settings) -> str | None:
    """Azure OpenAI, OpenAI itself, or anything wearing the same API."""
    # Imported inside the call rather than at module scope so the rest of the
    # service -- and its tests -- still run without the SDK installed.
    try:
        from openai import AzureOpenAI, OpenAI, OpenAIError
    except ImportError as exc:  # pragma: no cover - depends on the install
        raise NamingError(
            "The openai package is not installed on the server.") from exc

    if settings.provider == "azure":
        client = AzureOpenAI(
            azure_endpoint=settings.azure_endpoint,
            api_key=settings.azure_key,
            api_version=settings.azure_api_version,
            timeout=120.0, max_retries=1,
        )
    else:
        client = OpenAI(
            api_key=settings.key() or "unused",
            # Only the custom provider overrides the base URL; OpenAI proper
            # uses the SDK's own.
            base_url=settings.compatible_url or None,
            timeout=120.0, max_retries=1,
        )

    try:
        reply = client.chat.completions.create(
            model=settings.model(),
            messages=[
                {"role": "system", "content": instructions_for(req, settings)},
                {"role": "user", "content": _blocks(req)},
            ],
            response_format={"type": "json_object"},
            temperature=0.2,
            max_tokens=_budget(req),
        )
    except OpenAIError as exc:
        raise NamingError(str(exc)) from exc
    return reply.choices[0].message.content


def _ask_anthropic(req: NameRequest, settings: Settings) -> str | None:
    """Claude, whose images, system prompt and JSON contract all differ."""
    try:
        import anthropic
    except ImportError as exc:  # pragma: no cover - depends on the install
        raise NamingError(
            "The anthropic package is not installed on the server.") from exc

    client = anthropic.Anthropic(api_key=settings.anthropic_key,
                                 timeout=120.0, max_retries=1)
    try:
        reply = client.messages.create(
            model=settings.anthropic_model,
            max_tokens=_budget(req),
            # The instructions are the system prompt here, not a first message.
            system=instructions_for(req, settings),
            messages=[{"role": "user",
                       "content": _blocks(req, _anthropic_image)}],
            output_config={
                # Naming a part from a picture is a judgement, not a puzzle, so
                # the low setting keeps it quick and cheap. Describing one asks
                # for more thought, and gets the default.
                **({"effort": "low"} if not req.describe else {}),
                "format": {"type": "json_schema",
                           "schema": reply_schema(req.describe)},
            },
        )
    except anthropic.AnthropicError as exc:
        raise NamingError(str(exc)) from exc

    if reply.stop_reason == "refusal":
        raise NamingError("The model declined to answer.")
    return next((b.text for b in reply.content if b.type == "text"), None)


def instructions_for(req: NameRequest, settings: Settings) -> str:
    """The system prompt: the naming half, plus the describing half if wanted."""
    if not req.describe:
        return settings.instructions
    return f"{settings.instructions}\n\n{settings.describe_instructions}"


def name_parts(req: NameRequest, settings: Settings) -> dict[int, dict]:
    """Name one chunk of parts. Returns {index: {name, details}}."""
    ask = _ask_anthropic if settings.provider == "anthropic" else _ask_openai
    return _read(ask(req, settings), req)
