"""A ReAct loop that works out what an assembly is before naming its parts.

The plain namer in ``naming.py`` sends every part at once, framed tight against
a backdrop, and takes whatever comes back. That fails in a specific and
expensive way: a part photographed alone has no scale and no neighbours, its
silhouette is genuinely ambiguous, and once a run has decided the assembly is a
quad bike every remaining answer is generated to fit that story. An office chair
came back as an all-terrain vehicle, castor by castor.

This module fixes that by making the run *reason* instead of answering:

  observe -> think -> act -> observe

The browser is the agent's eyes. It already has the model in WebGL, so it can
frame any part from any angle in milliseconds; what it cannot do is hold an API
key. So the loop is split. This module owns the transcript and decides what to
look at next; the browser renders what it is asked for and posts the pixels
back. One HTTP round trip per thought.

Four things make the answers hold up, and none of them is a better prompt:

* **The assembly is identified first**, from four views of the whole model, and
  that sentence is pinned into every later request. The wrong prior is the
  single most expensive failure, so it is settled once, cheaply, and -- when the
  user asks for it -- confirmed by a human before 46 parts are named against it.
* **Parts are shot in their neighbourhood**, framed on their own box grown a few
  times, with their neighbours solid around them. Shape, scale and what a part
  bolts to arrive in one image.
* **Geometry travels as text.** Size in the file's own units, height above the
  base, which side it sits on, vertex and face counts, material. This costs
  nothing and is what separates a 2 cm bolt from a 51 cm cushion when both fill
  the frame.
* **The agent may ask to look again.** A part it cannot place gets another
  angle rather than a guess, up to a bounded number of rounds, and whatever it
  finally commits carries a confidence and the evidence behind it.

Images are deliberately *not* carried forward between steps. The durable memory
is textual -- the subject, the facts table, the names already given -- because
re-sending a hundred JPEGs on every turn would cost more than the run is worth
and buys nothing the text does not already say.
"""

from __future__ import annotations

import json
import time
import uuid

from pydantic import BaseModel, Field

from . import naming, parts_doc
from .settings import Settings

# Sessions are held in memory: a run lasts a minute or two and means nothing
# after the browser has gone. A handful is plenty -- one user, one model at a
# time -- and the cap stops an abandoned tab pinning a survey forever.
MAX_SESSIONS = 8
SESSION_TTL = 30 * 60

# A ceiling on the whole run, counted in round trips. A 500-part model at four
# parts a batch is 125 steps before any second look, so this is generous; it is
# here so a loop that has gone wrong stops rather than spends.
MAX_STEPS = 400
# How many times the agent may ask to see one batch again before it has to
# commit to a name with whatever confidence it has.
MAX_LOOKS = 2

MAX_PARTS = parts_doc.MAX_PARTS
MAX_IMAGE_CHARS = naming.MAX_IMAGE_CHARS
MAX_NAME_LEN = naming.MAX_NAME_LEN

VIEWS = ("whole", "neighbourhood", "isolated", "context", "scaled")
CONFIDENCE = ("high", "medium", "low")
FRONT_AXES = ("+X", "-X", "+Z", "-Z")

# The four angles the whole model is shot from. Two is not enough to tell a
# chair's front from its back; four is, and it is still one request.
SURVEY_ANGLES = (0, 90, 180, 270)

# A part is treated as a modelling artefact, not a component, when it has one
# face or none: three vertices cannot enclose a volume, so it draws as an
# invisible sliver. Nothing rendered can identify it, which is exactly why the
# plain namer invents something. These never reach the model.
ARTEFACT_NAME = "Modelling Artefact"
ARTEFACT_DETAILS = {
    "What it is": "A stray fragment left over from the modelling or scanning of "
                  "this file -- a single triangle, with no thickness and no volume.",
    "What it does": "Nothing. It draws as an invisible sliver and is not a "
                    "component of the assembly.",
    "How it is used": "It is not. Hide it, merge it into the part it sits on, "
                      "or delete it.",
    "Purpose": "None. This is a modelling artefact rather than a part.",
    "How it was found": "From the geometry, not from a picture: one face means "
                        "no enclosed volume, so no rendered view could show it.",
}


class AgentError(RuntimeError):
    """The run cannot go on. The message is meant for the page."""


# --- what the browser tells us about the model -------------------------------

class PartFacts(BaseModel):
    """One part, measured. No pixels -- this is the free half of the evidence."""

    index: int = Field(ge=0)
    name: str = Field("", max_length=MAX_NAME_LEN)
    vertices: int = Field(0, ge=0)
    faces: int = Field(0, ge=0)
    # Axis-aligned box and its centre, in the file's own units.
    size: list[float] = Field(default_factory=list, max_length=3)
    centre: list[float] = Field(default_factory=list, max_length=3)
    # Distance from the part's centre to its furthest vertex. Unlike the box,
    # this does not change when the same component is rotated onto another
    # mounting, which is what makes it usable for spotting repeats.
    radius: float = 0.0
    material: str = Field("", max_length=120)

    @property
    def degenerate(self) -> bool:
        return self.faces <= 1


class Survey(BaseModel):
    """Everything measurable about the model, sent once when the run starts."""

    extents: list[float] = Field(default_factory=list, max_length=3)
    base: list[float] = Field(default_factory=list, max_length=3)
    parts: list[PartFacts] = Field(min_length=1, max_length=MAX_PARTS)


# --- what we ask the browser for ---------------------------------------------

class ShotSpec(BaseModel):
    """One render for the browser to take. ``key`` comes back with the pixels."""

    key: str
    index: int = -1                       # -1 means the whole model
    view: str = "neighbourhood"
    yaw: int = 0                          # degrees around the resting angle
    pitch: int = 0
    grow: float = 3.0                     # neighbourhood framing, as a multiple


class Observation(BaseModel):
    key: str
    image: str = Field("", max_length=MAX_IMAGE_CHARS)


class Ask(BaseModel):
    """A question for the person watching. The run stops here until it is answered."""

    kind: str = "subject"                 # 'subject' or 'part'
    index: int = -1
    question: str
    detail: str = ""
    options: list[str] = Field(default_factory=list)
    # Which of the images just rendered to show beside the question.
    image_key: str = ""


class NamedPart(BaseModel):
    index: int
    name: str
    details: dict[str, str] = Field(default_factory=dict)
    confidence: str = "medium"
    evidence: str = ""


class StartRequest(BaseModel):
    survey: Survey
    # What the user has the slider on for *this* run, as a percentage of the
    # model's longest dimension. Sent rather than read from the settings so the
    # control in the parts list -- which shows live which parts it takes in and
    # which it leaves out -- is the thing that decides, and the saved setting is
    # only where the slider starts.
    min_part_size: float | None = Field(None, ge=0.0, le=25.0)


class StepRequest(BaseModel):
    session: str
    seen: list[Observation] = Field(default_factory=list, max_length=64)
    answer: str = Field("", max_length=400)


class StepReply(BaseModel):
    session: str
    phase: str
    note: str = ""
    shoot: list[ShotSpec] = Field(default_factory=list)
    ask: Ask | None = None
    named: list[NamedPart] = Field(default_factory=list)
    subject: str = ""
    done: int = 0
    total: int = 0
    finished: bool = False
    summary: str = ""


# --- geometry the server works out for itself --------------------------------

def _round(values: list[float], places: int = 2) -> tuple:
    return tuple(round(float(v), places) for v in values)


def exact_groups(parts: list[PartFacts]) -> dict[int, list[int]]:
    """Parts that are the same component, keyed by the first of each set.

    Matching is exact -- same vertex count, same face count, same box to two
    decimals -- and deliberately so. An instanced or mirrored duplicate matches
    exactly; a copy that has been *rotated* onto its mounting does not, because
    the axis-aligned box turns with it. Those are handled as a hint further down
    instead, because merging two parts that only look alike would give both the
    same wrong name, which is worse than naming each of them.
    """
    seen: dict[tuple, int] = {}
    out: dict[int, list[int]] = {}
    for part in parts:
        if part.degenerate:
            continue
        key = (part.vertices, part.faces, _round(sorted(part.size)), part.material)
        first = seen.setdefault(key, part.index)
        out.setdefault(first, []).append(part.index)
    return out


def near_duplicates(parts: list[PartFacts], of: PartFacts) -> list[int]:
    """Parts that are probably the same component as ``of``, rotated.

    Same material, face count within a tenth, and a bounding-sphere radius
    within a tenth -- the radius being the measure a rotation does not change.
    Offered to the model as something to consider, never enforced.
    """
    if of.degenerate or not of.radius:
        return []
    near = []
    for part in parts:
        if part.index == of.index or part.degenerate or part.material != of.material:
            continue
        if not part.radius or not of.faces:
            continue
        if abs(part.faces - of.faces) > 0.1 * of.faces:
            continue
        if abs(part.radius - of.radius) > 0.1 * of.radius:
            continue
        near.append(part.index)
    return near


def too_small(part: PartFacts, survey: Survey, percent: float) -> bool:
    """Is this part below the size the user asked to bother with?

    Measured on the longest side rather than volume: a wiring loom or a long
    thin rod has almost no volume and is still a part worth naming, where a
    washer is small however you measure it.
    """
    if percent <= 0:
        return False
    model = max(survey.extents or [0.0])
    if model <= 0:
        return False
    return max(part.size or [0.0]) < model * percent / 100


def _axes(front: str) -> tuple[int, int, int, int]:
    """Which array slots and signs mean forward and left, for a given facing.

    Left is ``up x forward`` with +Y up, so a model facing +Z has its own left
    at +X -- the same convention a vehicle's near side follows.
    """
    axis = {"+X": (0, 1), "-X": (0, -1), "+Z": (2, 1), "-Z": (2, -1)}[front]
    fore, sign = axis
    side = 2 if fore == 0 else 0
    # up x forward: (+Z, +1) -> +X; (+X, +1) -> -Z.
    side_sign = sign if fore == 2 else -sign
    return fore, sign, side, side_sign


def qualify(members: list[PartFacts], front: str) -> dict[int, str]:
    """Tell identical parts apart by where each one sits.

    Four identical bolts really are all "Armrest Bolt"; what makes one of them
    findable is that it is the front left one. Positions are measured against
    the spread of the group itself, not the whole model, so a label describes
    the set it belongs to. Anything near the middle of the group takes no word
    for that axis rather than being forced to a side.
    """
    if len(members) < 2:
        return {members[0].index: ""} if members else {}

    fore, fore_sign, side, side_sign = _axes(front)

    def spread(at: int, sign: int) -> dict[int, float]:
        values = {m.index: sign * (m.centre[at] if len(m.centre) > at else 0.0)
                  for m in members}
        low, high = min(values.values()), max(values.values())
        mid, half = (low + high) / 2, (high - low) / 2
        if half < 1e-9:
            return {i: 0.0 for i in values}
        return {i: (v - mid) / half for i, v in values.items()}

    along = spread(fore, fore_sign)
    across = spread(side, side_sign)
    # Wide enough that a part sitting near the middle of the group is called
    # neither front nor back, which is what makes a five-armed base read as
    # "Front Left, Front Right, Left, Right, Rear" rather than inventing corners.
    band = 0.3

    labels: dict[int, str] = {}
    for member in members:
        words = []
        if along[member.index] > band:
            words.append("Front")
        elif along[member.index] < -band:
            words.append("Rear")
        if across[member.index] > band:
            words.append("Left")
        elif across[member.index] < -band:
            words.append("Right")
        labels[member.index] = " ".join(words)

    # Two members that landed on the same words still have to be told apart.
    taken: dict[str, int] = {}
    for member in sorted(members, key=lambda m: m.index):
        word = labels[member.index]
        if list(labels.values()).count(word) > 1:
            taken[word] = taken.get(word, 0) + 1
            labels[member.index] = f"{word} #{taken[word]}".strip()
    return labels


# --- the transcript ----------------------------------------------------------

class Session:
    """One run. Holds the survey, what has been settled, and what is still open."""

    def __init__(self, survey: Survey, settings: Settings,
                 min_part_size: float | None = None):
        self.id = uuid.uuid4().hex
        self.touched = time.time()
        self.survey = survey
        self.settings = settings
        self.phase = "identify"
        self.steps = 0

        self.subject = ""
        self.family = ""
        self.front = "+Z"
        self.subject_evidence = ""
        self.subject_confidence = "medium"

        self.by_index = {p.index: p for p in survey.parts}
        self.groups = exact_groups(survey.parts)
        self.floor = (settings.min_part_size if min_part_size is None
                      else min_part_size)
        # Parts the user's size floor leaves out. They keep the name the file
        # gave them and get no description: not analysed, and so nothing
        # invented about them either. They stay in the part list, because the
        # document's index has to keep pointing at the right part in the file.
        self.skipped = {p.index for p in survey.parts
                        if not p.degenerate and too_small(p, survey, self.floor)}
        # Only one part of each identical set is looked at; the rest inherit.
        self.queue = [i for i in sorted(self.groups)
                      if not self.by_index[i].degenerate and i not in self.skipped]
        self.named: dict[int, NamedPart] = {}
        self.taken: list[str] = []

        # What the browser was last asked for, so a reply can be matched to it.
        self.pending: dict[str, ShotSpec] = {}
        self.batch: list[int] = []
        self.looks = 0
        # Parts the agent named but was not sure of, and which of them the user
        # is being asked about right now.
        self.unsure: list[int] = []
        self.asked = -1
        # What the last reply wanted another look at, handed from the thinking
        # step to the loop that drives it.
        self.again: list[dict] = []

    @property
    def total(self) -> int:
        return len(self.survey.parts)

    def alive(self) -> bool:
        return time.time() - self.touched < SESSION_TTL


_sessions: dict[str, Session] = {}


def _sweep() -> None:
    for key in [k for k, s in _sessions.items() if not s.alive()]:
        _sessions.pop(key, None)
    while len(_sessions) > MAX_SESSIONS:
        _sessions.pop(min(_sessions, key=lambda k: _sessions[k].touched), None)


def get(session_id: str) -> Session:
    _sweep()
    found = _sessions.get(session_id)
    if found is None:
        raise AgentError("That naming run has expired. Start it again.")
    found.touched = time.time()
    return found


def close(session_id: str) -> None:
    _sessions.pop(session_id, None)


# --- what the model is told --------------------------------------------------

def _dims(values: list[float]) -> str:
    return " x ".join(f"{v:.1f}" for v in (values or [0, 0, 0]))


def _facts_line(session: Session, part: PartFacts) -> str:
    """One part's measurements, as a sentence the model can use."""
    fore, fore_sign, side, side_sign = _axes(session.front)
    base = session.survey.base or [0, 0, 0]
    centre = part.centre or [0, 0, 0]

    height = centre[1] - (base[1] if len(base) > 1 else 0.0)
    across = side_sign * centre[side]
    along = fore_sign * centre[fore]
    where = (f"{height:.1f} above the base of the model, "
             f"{abs(across):.1f} to the {'left' if across >= 0 else 'right'} of "
             f"the centre line, {abs(along):.1f} toward the "
             f"{'front' if along >= 0 else 'back'}")

    line = (f'Part {part.index}, called "{part.name}" in the file. '
            f"Measures {_dims(part.size)} against the whole model's "
            f"{_dims(session.survey.extents)}. Sits {where}. "
            f"{part.vertices} vertices, {part.faces} faces")
    if part.material:
        line += f', material "{part.material}"'
    line += "."

    same = session.groups.get(part.index, [])
    if len(same) > 1:
        line += (f" {len(same)} parts in this model have exactly this geometry, "
                 "so whatever you call this one names all of them.")
    near = near_duplicates(session.survey.parts, part)
    if near:
        line += (f" Parts {', '.join(str(n) for n in near[:8])} are close to it "
                 "in size and complexity and may be the same component mounted "
                 "at a different angle.")
    return line


AGENT_RULES = (
    "You are identifying the parts of a 3D assembly for an engineer browsing it, "
    "and you are working as an agent: you may ask to look again instead of "
    "guessing."
    "\n\n"
    "Each part is shown in its neighbourhood -- highlighted in orange, framed on "
    "itself with its neighbours solid around it -- so you can see its shape, its "
    "size next to what it touches, and what it fastens to. Alongside every "
    "picture you are given the part's real measurements, where it sits in the "
    "model, and how complex it is. Use the measurements: they are exact, and "
    "they are what tells a 2 cm fastener from a 50 cm panel when both fill the "
    "frame."
    "\n\n"
    "Name a part for the job it does in *this* assembly, which has already been "
    "identified for you. Never carry over vocabulary from a different kind of "
    "machine because a shape reminds you of one -- a telescoping cylinder in a "
    "chair is a gas lift, not a hydraulic ram."
    "\n\n"
    'For every part give a short "evidence" note first -- what in the picture or '
    "the measurements decides it -- and a confidence of high, medium or low. If "
    "you cannot place a part, do not invent a use for it: either put it in "
    '"look_again" with the view you want, or name it by its plain shape '
    '("Curved Bracket") and mark the confidence low. An honest low beats a '
    "confident invention, because low confidence is shown to the user and a "
    "wrong name is not."
)


def _identify_schema() -> dict:
    return {
        "type": "object",
        "properties": {
            "subject": {"type": "string"},
            "family": {"type": "string"},
            "front_axis": {"type": "string", "enum": list(FRONT_AXES)},
            "confidence": {"type": "string", "enum": list(CONFIDENCE)},
            "evidence": {"type": "string"},
        },
        "required": ["subject", "family", "front_axis", "confidence", "evidence"],
        "additionalProperties": False,
    }


def _name_schema(describe: bool) -> dict:
    part = {
        "type": "object",
        "properties": {
            "id": {"type": "integer"},
            "name": {"type": "string"},
            "evidence": {"type": "string"},
            "confidence": {"type": "string", "enum": list(CONFIDENCE)},
        },
        "required": ["id", "name", "evidence", "confidence"],
        "additionalProperties": False,
    }
    if describe:
        part["properties"]["details"] = naming.DETAILS_SCHEMA
        part["required"] = [*part["required"], "details"]
    return {
        "type": "object",
        "properties": {
            "parts": {"type": "array", "items": part},
            "look_again": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "id": {"type": "integer"},
                        "view": {"type": "string", "enum": list(VIEWS)},
                        "yaw": {"type": "integer"},
                        "why": {"type": "string"},
                    },
                    "required": ["id", "view", "yaw", "why"],
                    "additionalProperties": False,
                },
            },
        },
        "required": ["parts"],
        "additionalProperties": False,
    }


def _body(reply: str | None) -> dict:
    try:
        found = json.loads(reply or "")
    except json.JSONDecodeError as exc:
        raise AgentError("The model did not reply with JSON.") from exc
    if not isinstance(found, dict):
        raise AgentError("The model's reply was not an object.")
    return found


# --- the two thinking steps --------------------------------------------------

def _identify(session: Session, seen: dict[str, str]) -> None:
    """Decide what the whole assembly is, from four views of it."""
    angles = [session.pending[k] for k in session.pending if session.pending[k].view == "whole"]
    shots = [(spec, seen.get(spec.key, "")) for spec in sorted(angles, key=lambda s: s.yaw)]
    shots = [(spec, data) for spec, data in shots if data]
    if not shots:
        raise AgentError("The browser sent no pictures of the model.")

    counts = [p.faces for p in session.survey.parts]
    summary = (
        f"This model has {len(session.survey.parts)} separate parts and measures "
        f"{_dims(session.survey.extents)} in its own units. The largest part has "
        f"{max(counts)} faces, the smallest {min(counts)}."
    )

    def blocks(image):
        out = [{"type": "text", "text":
                "Four views of a whole assembly, taken square on to the world "
                "axes: 0 degrees looks at it from the +Z side, 90 from +X, "
                "180 from -Z, 270 from -X, each slightly above eye level. "
                + summary}]
        for spec, data in shots:
            out.append({"type": "text", "text": f"Turned {spec.yaw} degrees:"})
            out.append(image(data))
        out.append({"type": "text", "text":
                    "Say what this assembly is. Be specific about the kind of "
                    "object -- the make or model line where you can see it, "
                    "otherwise the category an engineer would use. "
                    '"family" is the one or two word category, "subject" the '
                    "fuller description."
                    "\n\n"
                    '"front_axis" is the direction the object itself faces: the '
                    "direction you would walk from the model to end up standing "
                    "in front of it, looking at its face. +Y is up, and the four "
                    "views are taken square on to the axes, so the answer is "
                    "simply the view the front is seen in: 0 degrees is the +Z "
                    "side, 90 is +X, 180 is -Z and 270 is -X. Pick the one whose "
                    "picture shows the front. This decides which side of the "
                    "model is called left and which right in the part names."
                    "\n\n"
                    "Reply with JSON only, as "
                    '{"subject": "...", "family": "...", "front_axis": "+Z", '
                    '"confidence": "high", "evidence": "..."}.'})
        return out

    found = _body(naming.ask(
        AGENT_RULES, blocks, _identify_schema(), 700, session.settings))

    session.subject = " ".join(str(found.get("subject", "")).split())[:200]
    session.family = " ".join(str(found.get("family", "")).split())[:80]
    session.subject_evidence = " ".join(str(found.get("evidence", "")).split())[:400]
    if found.get("confidence") in CONFIDENCE:
        session.subject_confidence = found["confidence"]
    if found.get("front_axis") in FRONT_AXES:
        session.front = found["front_axis"]
    if not session.subject:
        raise AgentError("The model could not say what this assembly is.")


def _name_batch(session: Session, seen: dict[str, str]) -> list[dict]:
    """Name the parts in the current batch, or ask to see some of them again."""
    shots: dict[int, list[tuple[ShotSpec, str]]] = {}
    for spec in session.pending.values():
        data = seen.get(spec.key, "")
        if data and spec.index >= 0:
            shots.setdefault(spec.index, []).append((spec, data))
    if not shots:
        raise AgentError("The browser sent no pictures of the parts.")

    ids = [i for i in session.batch if i in shots]

    def blocks(image):
        out = [{"type": "text", "text":
                f"This assembly has already been identified as: {session.subject}. "
                f"Every part below belongs to it. It faces {session.front} and "
                "+Y is up."}]
        for index in ids:
            part = session.by_index[index]
            out.append({"type": "text", "text": _facts_line(session, part)})
            for spec, data in sorted(shots[index], key=lambda s: (s[0].view, s[0].yaw)):
                label = {"neighbourhood": "In place, highlighted in orange",
                         "isolated": "On its own",
                         "context": "Highlighted in the whole assembly",
                         "scaled": "Alone, at its true size within the model",
                         "whole": "The whole model"}[spec.view]
                if spec.yaw:
                    label += f", turned {spec.yaw} degrees"
                out.append({"type": "text", "text": label + ":"})
                out.append(image(data))

        if session.taken:
            out.append({"type": "text", "text":
                        "Names already given to other parts of this model. Do "
                        "not repeat one unless this part really is another of "
                        "the same thing: " + ", ".join(session.taken[-60:])})

        contract = ('{"parts": [{"id": <id>, "evidence": "<what decides it>", '
                    '"name": "<name>", "confidence": "high|medium|low"'
                    + (', "details": [{"label": "<label>", "text": "<text>"}]'
                       if session.settings.describe else "")
                    + '}], "look_again": [{"id": <id>, "view": '
                    '"neighbourhood|isolated|context|scaled", "yaw": <degrees>, '
                    '"why": "<what you are trying to see>"}]}')
        if session.looks < MAX_LOOKS:
            more = ("Put a part in \"look_again\" instead of naming it if another "
                    "view would settle it -- a yaw of 90 or 180 gets round a "
                    "neighbour that is in the way. Everything you do name must "
                    "still appear in \"parts\".")
        else:
            more = ("You have already looked again as often as this run allows, "
                    "so leave \"look_again\" empty and name every part, marking "
                    "the ones you are unsure of as low confidence.")
        out.append({"type": "text", "text":
                    f"{more} Reply with JSON and nothing else, in the form "
                    f"{contract}, covering these ids: "
                    f"{', '.join(str(i) for i in ids)}."})
        return out

    budget = 300 + (1100 if session.settings.describe else 220) * max(len(ids), 1)
    found = _body(naming.ask(
        f"{AGENT_RULES}\n\n{session.settings.describe_instructions}"
        if session.settings.describe else AGENT_RULES,
        blocks, _name_schema(session.settings.describe), budget, session.settings))

    wanted = set(ids)
    named = []
    for entry in found.get("parts") or []:
        index = naming.entry_id(entry)
        if index is None:
            continue
        name = " ".join(str(entry.get("name", "")).split())[:MAX_NAME_LEN]
        if index not in wanted or not name:
            continue
        confidence = entry.get("confidence")
        named.append({
            "index": index,
            "name": "".join(c for c in name if c.isprintable()),
            "confidence": confidence if confidence in CONFIDENCE else "medium",
            "evidence": " ".join(str(entry.get("evidence", "")).split())[:400],
            "details": parts_doc.clean_details(entry.get("details"))
            if session.settings.describe else {},
        })

    again = []
    if session.looks < MAX_LOOKS:
        for entry in found.get("look_again") or []:
            index = naming.entry_id(entry)
            if index is None:
                continue
            if index in wanted:
                again.append({
                    "index": index,
                    "view": entry.get("view") if entry.get("view") in VIEWS
                    else "neighbourhood",
                    "yaw": max(-180, min(180, int(entry.get("yaw") or 90))),
                })

    session.again = again           # read by the caller, which drives the loop
    return named


# --- committing --------------------------------------------------------------

def _whole_family(session: Session, members: list[PartFacts]) -> bool:
    """Is this set of identical parts all of them, or only the ones that matched?

    Exact matching finds a subset when the rest of a family has been rotated
    onto its mountings. Labelling two of five castors "front right" and "rear
    left" would then be worse than not labelling them: a position out of a set
    that is not all there points at corners the model does not have. So the
    words are only spent when nothing outside the set looks like it belongs in
    it.
    """
    inside = {m.index for m in members}
    return not any(set(near_duplicates(session.survey.parts, m)) - inside
                   for m in members)


def _commit(session: Session, named: list[dict]) -> list[NamedPart]:
    """Write one batch's answers onto every part they cover.

    A name given to one part of an identical set names all of them, told apart
    by where each one sits. That is the whole reason only one of a set is ever
    looked at.
    """
    out: list[NamedPart] = []
    for answer in named:
        index = answer["index"]
        members = [session.by_index[i] for i in session.groups.get(index, [index])
                   if i in session.by_index]
        labels = (qualify(members, session.front) if _whole_family(session, members)
                  else {m.index: "" for m in members})
        for member in members:
            label = labels.get(member.index, "")
            full = f"{label} {answer['name']}".strip() if label else answer["name"]
            part = NamedPart(index=member.index, name=full[:MAX_NAME_LEN],
                             details=answer["details"],
                             confidence=answer["confidence"],
                             evidence=answer["evidence"])
            session.named[member.index] = part
            session.taken.append(full)
            out.append(part)
        # Once each: a part re-committed after a second look must not queue up
        # two questions about itself.
        if answer["confidence"] == "low" and index not in session.unsure:
            session.unsure.append(index)
        elif answer["confidence"] != "low" and index in session.unsure:
            session.unsure.remove(index)
    return out


def _rename(session: Session, index: int, answer: str) -> list[NamedPart]:
    """Put the user's word in place of the agent's, across an identical set.

    An empty answer, or one matching what was proposed, means the agent had it
    right; the part keeps its name but stops being flagged as uncertain, since
    a person has now looked at it.
    """
    if index < 0 or index not in session.named:
        return []
    was = session.named[index]
    keep = not answer or answer.lower() in (was.name.lower(), "yes", "y")

    members = [session.by_index[i] for i in session.groups.get(index, [index])
               if i in session.by_index]
    labels = (qualify(members, session.front) if _whole_family(session, members)
              else {m.index: "" for m in members})
    out = []
    for member in members:
        part = session.named.get(member.index)
        if part is None:
            continue
        if not keep:
            label = labels.get(member.index, "")
            part.name = (f"{label} {answer}".strip() if label else answer)[:MAX_NAME_LEN]
            part.evidence = "Named by the user."
        part.confidence = "high"
        out.append(part)
    return out


def _artefacts(session: Session) -> list[NamedPart]:
    """Name the degenerate parts from their geometry, without asking anything."""
    out = []
    for part in session.survey.parts:
        if not part.degenerate or part.index in session.named:
            continue
        found = NamedPart(index=part.index, name=ARTEFACT_NAME,
                          details=dict(ARTEFACT_DETAILS), confidence="high",
                          evidence=f"{part.faces} face(s): no enclosed volume.")
        session.named[part.index] = found
        out.append(found)
    return out


# --- the loop ----------------------------------------------------------------

def _shots_for(session: Session, batch: list[int]) -> list[ShotSpec]:
    """What to render for one batch.

    A neighbourhood crop each, which is the view that actually identifies a
    part, and a tight isolated shot alongside it for the fine detail the crop
    is too far back to show.
    """
    specs: list[ShotSpec] = []
    for index in batch:
        specs.append(ShotSpec(key=f"p{index}n", index=index, view="neighbourhood"))
        specs.append(ShotSpec(key=f"p{index}i", index=index, view="isolated"))
    return specs


def _next_batch(session: Session) -> list[int]:
    size = max(1, min(session.settings.agent_batch, 8))
    batch, session.queue = session.queue[:size], session.queue[size:]
    return batch


def _progress(session: Session) -> int:
    return len(session.named)


def _reply(session: Session, **over) -> StepReply:
    return StepReply(session=session.id, phase=session.phase,
                     subject=session.subject, done=_progress(session),
                     total=session.total, **over)


def _start_naming(session: Session) -> StepReply:
    session.phase = "name"
    named = _artefacts(session)
    session.batch = _next_batch(session)
    session.looks = 0
    session.pending = {s.key: s for s in _shots_for(session, session.batch)}
    return _reply(session, note=f"Naming parts of the {session.family or 'model'}",
                  shoot=list(session.pending.values()), named=named)


def _review_or_finish(session: Session) -> StepReply:
    """Either put the shaky names to the user, or write the run up.

    Only the parts the agent itself marked low confidence are raised. Asking
    about all of them would train the user to click through without reading,
    which is worse than not asking.
    """
    session.asked = -1
    if session.settings.agent_hitl == "full":
        while session.unsure:
            index = session.unsure.pop(0)
            part = session.named.get(index)
            if part is None:
                continue
            session.phase = "review"
            session.asked = index
            session.pending = {f"p{index}n": ShotSpec(
                key=f"p{index}n", index=index, view="neighbourhood")}
            return _reply(session, note="Checking the names it was unsure of",
                          shoot=list(session.pending.values()),
                          ask=Ask(kind="part", index=index,
                                  question=f'Is this a "{part.name}"?',
                                  detail=part.evidence
                                  or "The agent was not confident about this one.",
                                  options=[part.name],
                                  image_key=f"p{index}n"))
    return _finish(session)


def _finish(session: Session) -> StepReply:
    session.phase = "done"
    session.pending = {}
    artefacts = sum(1 for p in session.survey.parts if p.degenerate)
    shaky = sum(1 for p in session.named.values() if p.confidence == "low")
    bits = [f"{len(session.named) - artefacts} parts named"]
    if artefacts:
        bits.append(f"{artefacts} modelling artefact(s) set aside")
    if session.skipped:
        bits.append(f"{len(session.skipped)} left alone as under "
                    f"{session.floor:g}% of the model")
    if shaky:
        bits.append(f"{shaky} marked low confidence")
    return _reply(session, finished=True, note="Done",
                  summary=f"{session.subject}. " + ", ".join(bits) + ".")


def start(request: StartRequest, settings: Settings) -> StepReply:
    """Open a run and ask for the four views the whole model is identified from."""
    _sweep()
    session = Session(request.survey, settings, request.min_part_size)
    _sessions[session.id] = session
    session.pending = {
        f"w{yaw}": ShotSpec(key=f"w{yaw}", index=-1, view="whole", yaw=yaw)
        for yaw in SURVEY_ANGLES
    }
    return _reply(session, note="Looking at the whole model",
                  shoot=list(session.pending.values()))


def step(request: StepRequest, settings: Settings) -> StepReply:
    """One turn of the loop: take what the browser saw, decide what happens next."""
    session = get(request.session)
    session.settings = settings
    session.steps += 1
    if session.steps > MAX_STEPS:
        raise AgentError("This run took more steps than it is allowed. "
                         "Whatever was named has been kept.")

    seen = {o.key: o.image for o in request.seen if o.image}

    if session.phase == "identify":
        _identify(session, seen)
        if session.settings.agent_hitl in ("subject", "full"):
            session.phase = "confirm"
            # The picture is asked for again rather than referred back to: the
            # browser only holds the shots from the step it is answering, and a
            # question about what the model is with no model beside it is a
            # question nobody can check. One render is nothing.
            shown = ShotSpec(key="wq", index=-1, view="whole", yaw=0)
            session.pending = {shown.key: shown}
            return _reply(
                session, note="Checking what this model is",
                shoot=[shown],
                ask=Ask(kind="subject",
                        question=f"Is this a {session.subject}?",
                        detail=session.subject_evidence,
                        options=[session.subject],
                        image_key=shown.key))
        return _start_naming(session)

    if session.phase == "confirm":
        answer = " ".join(request.answer.split())[:200]
        if answer and answer.lower() not in (session.subject.lower(), "yes"):
            session.subject = answer
            session.family = answer
            session.subject_confidence = "high"
            session.subject_evidence = "Confirmed by the user."
        return _start_naming(session)

    if session.phase == "name":
        named = _name_batch(session, seen)
        committed = _commit(session, named)

        # A part the agent asked to see again is held back and re-shot; anything
        # it did name in the same reply still counts and is written out now.
        again = [w for w in session.again if w["index"] not in session.named]
        if again:
            session.looks += 1
            session.batch = [w["index"] for w in again]
            session.pending = {}
            for want in again:
                extra = ShotSpec(key=f"p{want['index']}x", index=want["index"],
                                 view=want["view"], yaw=want["yaw"])
                session.pending[extra.key] = extra
                session.pending[f"p{want['index']}n"] = ShotSpec(
                    key=f"p{want['index']}n", index=want["index"],
                    view="neighbourhood")
            return _reply(session, note="Looking again at a part it could not place",
                          shoot=list(session.pending.values()), named=committed)

        if not session.queue:
            reply = _review_or_finish(session)
            reply.named = committed + reply.named
            return reply

        session.batch = _next_batch(session)
        session.looks = 0
        session.pending = {s.key: s for s in _shots_for(session, session.batch)}
        return _reply(session, note="Naming parts",
                      shoot=list(session.pending.values()), named=committed)

    if session.phase == "review":
        changed = _rename(session, session.asked,
                          " ".join(request.answer.split())[:MAX_NAME_LEN])
        reply = _review_or_finish(session)
        reply.named = changed + reply.named
        return reply

    return _finish(session)
