"""The naming agent: what it looks at, what it refuses to guess, when it asks.

The provider is stubbed throughout -- ``naming.ask`` is the one door the agent
goes through -- so what these check is the reasoning around it: that the
assembly is settled before any part is named, that a part with no volume never
reaches a vision model at all, that identical parts are looked at once and told
apart by where they sit, and that a part the agent cannot place gets another
look rather than an invention.

The survey used here is a small chair, because that is the shape the old namer
got wrong: five identical castors, a base, a seat, two mirrored arms, and one
single-triangle scrap of the sort a scan leaves behind.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

os.environ.setdefault("CONVERTER_DATA_DIR", str(Path(__file__).parent / "_data"))

from app import agent, naming, settings as settings_store  # noqa: E402
from app.main import app  # noqa: E402

client = TestClient(app)

PIXEL = "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBk"

# Where the five legs of the base sit, going round. The middle two are near the
# midline front-to-back, which is what makes them "Left" and "Right" rather than
# corners that do not exist on a five-armed base.
LEGS = [(19.8, 26.2), (-19.5, 27.2), (31.9, -9.8), (-31.2, -10.7), (0.0, -33.4)]


def facts(index, name, *, size, centre, faces=400, vertices=300, radius=3.0,
          material="Chair"):
    return {"index": index, "name": name, "vertices": vertices, "faces": faces,
            "size": list(size), "centre": list(centre), "radius": radius,
            "material": material}


def chair() -> dict:
    """A survey shaped like the model that started all this."""
    parts = []
    for n, (x, z) in enumerate(LEGS):
        # Identical geometry, five different mountings.
        parts.append(facts(n, f"polySurface{n}", size=(5.3, 5.1, 5.7),
                           centre=(x, 2.5, z), faces=328, vertices=326, radius=4.1))
    parts.append(facts(5, "polySurface5", size=(65.2, 16.1, 62.1),
                       centre=(0.0, 15.1, -3.0), faces=827, vertices=827, radius=45.0))
    parts.append(facts(6, "polySurface6", size=(51.0, 12.0, 50.7),
                       centre=(0.1, 43.9, 2.8), faces=591, vertices=591, radius=36.0))
    # A mirrored pair: same geometry, opposite sides.
    parts.append(facts(7, "polySurface7", size=(3.8, 22.3, 30.4),
                       centre=(27.0, 55.5, 0.2), faces=564, vertices=564, radius=19.0))
    parts.append(facts(8, "polySurface8", size=(3.8, 22.3, 30.4),
                       centre=(-26.8, 55.5, 0.2), faces=564, vertices=564, radius=19.0))
    # One face: a scan scrap, not a part.
    parts.append(facts(9, "polySurface9", size=(39.6, 8.8, 1.5),
                       centre=(5.1, 59.1, -23.7), faces=1, vertices=3, radius=20.0))
    return {"extents": [69.3, 117.4, 68.3], "base": [-33.8, 0.0, -37.9],
            "parts": parts}


def configure(**over):
    saved = settings_store.Settings(
        azure_endpoint="https://example.openai.azure.com",
        azure_key="secret-key", azure_deployment="gpt-4o-vision", **over)
    settings_store.save(saved)
    return saved


@pytest.fixture(autouse=True)
def clean(monkeypatch):
    for name in ("AZURE_OPENAI_ENDPOINT", "AZURE_OPENAI_API_KEY",
                 "AZURE_OPENAI_DEPLOYMENT", "AZURE_OPENAI_API_VERSION"):
        monkeypatch.delenv(name, raising=False)
    path = settings_store.SETTINGS_PATH
    had = path.read_bytes() if path.exists() else None
    path.unlink(missing_ok=True)
    agent._sessions.clear()
    yield
    agent._sessions.clear()
    path.unlink(missing_ok=True)
    if had is not None:
        path.write_bytes(had)


class Provider:
    """Stands in for the deployment, and records what it was shown.

    ``replies`` is consumed in order; the last one is repeated once it runs out,
    which is what lets a test that only cares about the first few steps let the
    run finish.
    """

    def __init__(self, *replies):
        self.replies = list(replies)
        self.said: list[str] = []
        self.calls = 0

    def __call__(self, system, blocks, schema, max_tokens, settings, effort=None):
        self.calls += 1
        parts = blocks(lambda data: {"type": "image", "data": data})
        self.said.append(" ".join(
            b["text"] for b in parts if b.get("type") == "text"))
        self.images = [b for b in parts if b.get("type") == "image"]
        self.system = system
        self.schema = schema
        return self.replies.pop(0) if len(self.replies) > 1 else self.replies[0]


IDENTIFIED = json.dumps({
    "subject": "high-back mesh office chair", "family": "office chair",
    "front_axis": "+Z", "confidence": "high",
    "evidence": "Seat, backrest and a five-star castor base.",
})


def named(*ids, confidence="high", look=()):
    return json.dumps({
        "parts": [{"id": i, "name": f"Part {i}", "evidence": "shape and place",
                   "confidence": confidence} for i in ids],
        "look_again": [{"id": i, "view": "neighbourhood", "yaw": 180,
                        "why": "hidden behind the seat"} for i in look],
    })


def observed(reply: dict) -> list[dict]:
    return [{"key": spec["key"], "image": PIXEL} for spec in reply["shoot"]]


def to_review(session: str, step: dict) -> dict:
    """Drive on until the run asks about a part.

    With the full setting the subject question comes first; accepting it is
    what lets the run get as far as the parts it was unsure of.
    """
    for _ in range(40):
        if step["finished"] or (step["ask"] and step["ask"]["kind"] == "part"):
            return step
        step = client.post("/api/agent/step", json={
            "session": session, "seen": observed(step),
            "answer": "" if step["ask"] else ""}).json()
    return step


def run(monkeypatch, provider, *, answers=(), **over):
    """Drive a whole run to the end, answering any question in turn."""
    configure(**over)
    monkeypatch.setattr(naming, "ask", provider)
    said = list(answers)
    steps = [client.post("/api/agent/start",
                         json={"survey": chair()}).json()]
    while not steps[-1]["finished"] and len(steps) < 60:
        last = steps[-1]
        answer = said.pop(0) if last["ask"] and said else ""
        steps.append(client.post("/api/agent/step", json={
            "session": last["session"], "seen": observed(last), "answer": answer,
        }).json())
    return steps


# --- what the geometry settles on its own ------------------------------------

def test_identical_parts_are_found_and_the_rest_left_alone():
    parts = [agent.PartFacts(**p) for p in chair()["parts"]]
    groups = agent.exact_groups(parts)
    sets = sorted((sorted(v) for v in groups.values() if len(v) > 1), key=len)
    assert sets == [[7, 8], [0, 1, 2, 3, 4]]
    # The single-triangle scrap is not grouped with anything, or at all.
    assert 9 not in {i for v in groups.values() for i in v}


def test_a_rotated_copy_is_offered_as_a_hint_rather_than_merged():
    """Merging on a guess would give two parts the same wrong name."""
    parts = [agent.PartFacts(**p) for p in chair()["parts"]]
    # Same component, mounted turned: the box differs, the radius does not.
    turned = agent.PartFacts(**facts(10, "turned", size=(5.7, 5.1, 5.3),
                                     centre=(10, 2.5, 10), faces=330,
                                     vertices=331, radius=4.15))
    parts.append(turned)
    assert agent.exact_groups(parts).get(0) == [0, 1, 2, 3, 4]     # not merged
    assert 10 not in agent.exact_groups(parts)[0]
    assert 0 in agent.near_duplicates(parts, turned)               # but noticed


def test_a_five_armed_base_is_labelled_the_way_one_actually_is():
    members = [agent.PartFacts(**p) for p in chair()["parts"][:5]]
    labels = agent.qualify(members, "+Z")
    assert sorted(labels.values()) == ["Front Left", "Front Right", "Left",
                                       "Rear", "Right"]
    # The leg at the back on the centre line is the rear one.
    assert labels[4] == "Rear"


def test_a_mirrored_pair_is_just_left_and_right():
    members = [agent.PartFacts(**p) for p in chair()["parts"][7:9]]
    assert agent.qualify(members, "+Z") == {7: "Left", 8: "Right"}


def test_which_way_the_model_faces_decides_which_side_is_left():
    members = [agent.PartFacts(**p) for p in chair()["parts"][7:9]]
    # Turn the model round and the two arms swap hands, as they should.
    assert agent.qualify(members, "-Z") == {7: "Right", 8: "Left"}


def test_a_part_on_its_own_needs_no_qualifier():
    only = [agent.PartFacts(**chair()["parts"][5])]
    assert agent.qualify(only, "+Z") == {5: ""}


def test_a_size_floor_leaves_the_small_parts_alone(monkeypatch):
    """A 500-part assembly is mostly fasteners, and each one costs a request."""
    provider = Provider(IDENTIFIED, named(5, 6, 7))
    configure(agent_hitl="off", agent_batch=8, min_part_size=8.0)
    monkeypatch.setattr(naming, "ask", provider)

    first = client.post("/api/agent/start", json={"survey": chair()}).json()
    step, everything = first, {}
    shot = set()
    while not step["finished"]:
        shot |= {s["index"] for s in step["shoot"]}
        step = client.post("/api/agent/step", json={
            "session": first["session"], "seen": observed(step)}).json()
        everything.update({p["index"]: p["name"] for p in step["named"]})

    # The model is 117 units tall, so 8% is 9.4: the castors (5.7) go, the
    # base, seat and arms (30 and up) stay.
    assert shot & {0, 1, 2, 3, 4} == set()
    assert {5, 6, 7} <= shot
    # Skipped parts are never named, so they keep whatever the file called them.
    assert not ({0, 1, 2, 3, 4} & set(everything))
    assert "left alone as under 8% of the model" in step["summary"]


def test_the_floor_travels_with_the_run_rather_than_the_settings(monkeypatch):
    """The slider in the parts list is what decides, so a run can differ from
    the saved default without saving over it."""
    provider = Provider(IDENTIFIED, named(*range(9)))
    configure(agent_hitl="off", agent_batch=8, min_part_size=0.0)
    monkeypatch.setattr(naming, "ask", provider)

    first = client.post("/api/agent/start", json={
        "survey": chair(), "min_part_size": 8.0}).json()
    step, shot = first, set()
    while not step["finished"]:
        shot |= {s["index"] for s in step["shoot"]}
        step = client.post("/api/agent/step", json={
            "session": first["session"], "seen": observed(step)}).json()
    assert shot & {0, 1, 2, 3, 4} == set()
    assert settings_store.load().min_part_size == 0.0


def test_a_floor_of_zero_names_everything_as_it_always_did():
    configure(agent_hitl="off", min_part_size=0.0)
    first = client.post("/api/agent/start", json={"survey": chair()}).json()
    session = agent.get(first["session"])
    assert session.skipped == set()
    # The nine real parts, minus the four castors that share one geometry.
    assert session.queue == [0, 5, 6, 7]


def test_a_part_with_no_volume_is_set_aside_whatever_the_floor_says():
    """Its size is irrelevant: no rendered view can identify one face."""
    configure(agent_hitl="off", min_part_size=0.0)
    first = client.post("/api/agent/start", json={"survey": chair()}).json()
    session = agent.get(first["session"])
    assert 9 not in session.queue and 9 not in session.skipped
    assert session.by_index[9].degenerate


def test_the_floor_is_measured_on_the_longest_side_not_the_volume():
    """A wiring loom has almost no volume and is still worth naming."""
    survey = agent.Survey(**chair())
    rod = agent.PartFacts(**facts(11, "rod", size=(0.4, 0.4, 40.0),
                                  centre=(0, 20, 0)))
    washer = agent.PartFacts(**facts(12, "washer", size=(2.0, 0.2, 2.0),
                                     centre=(0, 5, 0)))
    assert agent.too_small(rod, survey, 8.0) is False
    assert agent.too_small(washer, survey, 8.0) is True


def test_a_kept_part_is_analysed_however_small_it_is():
    """The floor is a guess; clicking a part the run left out overrides it."""
    configure(agent_hitl="off", min_part_size=8.0)
    first = client.post("/api/agent/start", json={
        "survey": chair(), "keep": [3]}).json()
    session = agent.get(first["session"])
    # 3 is one of four identical castors, and 0 is the one that stands for the
    # set -- so that is what gets looked at, and 3 inherits its name.
    assert 0 in session.queue
    assert not ({0, 1, 2, 3, 4} & session.skipped)


def test_a_kept_part_with_no_volume_is_looked_at_after_all():
    configure(agent_hitl="off", min_part_size=0.0)
    first = client.post("/api/agent/start", json={
        "survey": chair(), "keep": [9]}).json()
    session = agent.get(first["session"])
    assert session.by_index[9].degenerate
    assert 9 in session.queue


def test_keeping_a_part_the_floor_never_touched_changes_nothing():
    configure(agent_hitl="off", min_part_size=8.0)
    plain = client.post("/api/agent/start", json={"survey": chair()}).json()
    kept = client.post("/api/agent/start", json={
        "survey": chair(), "keep": [6, 999]}).json()
    assert agent.get(kept["session"]).queue == agent.get(plain["session"]).queue


def test_an_out_of_range_floor_is_rejected():
    configure()
    assert client.post("/api/agent/start", json={
        "survey": chair(), "min_part_size": 90}).status_code == 422


# --- the loop ----------------------------------------------------------------

def test_a_run_starts_by_looking_at_the_whole_model():
    configure()
    first = client.post("/api/agent/start", json={"survey": chair()}).json()
    assert first["phase"] == "identify"
    assert [s["view"] for s in first["shoot"]] == ["whole"] * 4
    assert sorted(s["yaw"] for s in first["shoot"]) == [0, 90, 180, 270]
    # Nothing has been named, and no part has been photographed yet.
    assert first["named"] == [] and first["total"] == 10


def test_the_model_is_identified_before_a_single_part_is_named(monkeypatch):
    provider = Provider(IDENTIFIED, named(*range(9)))
    steps = run(monkeypatch, provider, agent_hitl="off", agent_batch=8)

    # The first request is about the whole model; only after it does any part
    # picture go anywhere.
    assert "Four views of a whole assembly" in provider.said[0]
    assert "Part 0" not in provider.said[0]
    assert "high-back mesh office chair" in provider.said[1]
    assert steps[-1]["finished"]


def test_a_run_stops_for_the_subject_before_spending_on_parts(monkeypatch):
    provider = Provider(IDENTIFIED, named(*range(9)))
    configure(agent_hitl="subject")
    monkeypatch.setattr(naming, "ask", provider)

    first = client.post("/api/agent/start", json={"survey": chair()}).json()
    second = client.post("/api/agent/step", json={
        "session": first["session"], "seen": observed(first)}).json()

    assert second["phase"] == "confirm"
    assert second["ask"]["kind"] == "subject"
    assert "high-back mesh office chair" in second["ask"]["question"]
    # The picture the answer rests on comes with the question, in this step's
    # own shots -- the browser no longer holds the ones it took last step.
    assert second["ask"]["image_key"] in {s["key"] for s in second["shoot"]}
    assert [s["view"] for s in second["shoot"]] == ["whole"]
    # And it has not gone on to name anything while waiting.
    assert provider.calls == 1 and second["named"] == []


def test_the_users_correction_is_what_the_parts_are_named_against(monkeypatch):
    provider = Provider(IDENTIFIED, named(*range(9)))
    configure(agent_hitl="subject")
    monkeypatch.setattr(naming, "ask", provider)

    first = client.post("/api/agent/start", json={"survey": chair()}).json()
    asked = client.post("/api/agent/step", json={
        "session": first["session"], "seen": observed(first)}).json()
    after = client.post("/api/agent/step", json={
        "session": first["session"], "seen": [],
        "answer": "dentist's stool"}).json()

    assert after["subject"] == "dentist's stool"
    client.post("/api/agent/step", json={
        "session": first["session"], "seen": observed(after)})
    assert "dentist's stool" in provider.said[-1]
    assert "high-back mesh office chair" not in provider.said[-1]
    assert asked["ask"]["options"] == ["high-back mesh office chair"]


def test_a_single_triangle_part_is_never_shown_to_the_model(monkeypatch):
    provider = Provider(IDENTIFIED, named(*range(9)))
    steps = run(monkeypatch, provider, agent_hitl="off", agent_batch=8)

    # It is never rendered...
    assert all(spec["index"] != 9 for step in steps for spec in step["shoot"])
    # ...never mentioned...
    assert all("Part 9," not in said for said in provider.said)
    # ...and still comes back named, from its geometry alone.
    scrap = next(p for step in steps for p in step["named"] if p["index"] == 9)
    assert scrap["name"] == agent.ARTEFACT_NAME
    assert "one face" in scrap["evidence"] or "1 face" in scrap["evidence"]
    assert "not a component" in scrap["details"]["What it does"]


def test_identical_parts_are_looked_at_once_and_told_apart_by_place(monkeypatch):
    provider = Provider(IDENTIFIED, named(0, 5, 6, 7))
    steps = run(monkeypatch, provider, agent_hitl="off", agent_batch=8)

    shot = {spec["index"] for step in steps for spec in step["shoot"]}
    # One castor of the five, one arm of the two.
    assert shot & {0, 1, 2, 3, 4} == {0}
    assert shot & {7, 8} == {7}

    everything = {p["index"]: p["name"] for step in steps for p in step["named"]}
    castors = {everything[i] for i in range(5)}
    assert castors == {"Front Left Part 0", "Front Right Part 0", "Left Part 0",
                       "Right Part 0", "Rear Part 0"}
    assert everything[7] == "Left Part 7" and everything[8] == "Right Part 7"


def test_a_half_found_set_is_not_given_positions_it_cannot_know(monkeypatch):
    """Exact matching finds a subset when the rest were rotated onto their
    mountings. Calling two of five castors "front right" and "rear left" points
    at corners the model does not have, so the words are withheld."""
    survey = chair()
    # Three more castors, the same component turned: near duplicates, not exact.
    for n, (x, z) in enumerate(LEGS[:3], start=10):
        survey["parts"].append(facts(n, f"turned{n}", size=(5.7, 5.1, 5.3),
                                     centre=(x, 2.5, z + 1), faces=330,
                                     vertices=331, radius=4.12))
    configure(agent_hitl="off", agent_batch=8)
    provider = Provider(IDENTIFIED, named(0, 5, 6, 7, 10, 11, 12))
    monkeypatch.setattr(naming, "ask", provider)

    first = client.post("/api/agent/start", json={"survey": survey}).json()
    step = first
    everything = {}
    while not step["finished"]:
        step = client.post("/api/agent/step", json={
            "session": first["session"], "seen": observed(step)}).json()
        everything.update({p["index"]: p["name"] for p in step["named"]})

    # The five exact matches are a set, but three lookalikes sit outside it.
    assert {everything[i] for i in range(5)} == {"Part 0"}
    # The arms, whose pair is all there is, keep their sides.
    assert everything[7] == "Left Part 7" and everything[8] == "Right Part 7"


def test_the_measurements_travel_beside_the_picture(monkeypatch):
    provider = Provider(IDENTIFIED, named(*range(9)))
    run(monkeypatch, provider, agent_hitl="off", agent_batch=8)
    parts_turn = provider.said[1]

    # Size against the whole, height off the floor, which side, how complex.
    assert "65.2 x 16.1 x 62.1" in parts_turn
    assert "69.3 x 117.4 x 68.3" in parts_turn
    assert "above the base of the model" in parts_turn
    assert "827 vertices, 827 faces" in parts_turn
    assert 'material "Chair"' in parts_turn
    # And the fact that one answer covers five parts.
    assert "5 parts in this model have exactly this geometry" in parts_turn


def test_every_part_is_shot_among_its_neighbours(monkeypatch):
    provider = Provider(IDENTIFIED, named(*range(9)))
    steps = run(monkeypatch, provider, agent_hitl="off", agent_batch=8)
    views = {spec["index"]: set() for step in steps for spec in step["shoot"]}
    for step in steps:
        for spec in step["shoot"]:
            views[spec["index"]].add(spec["view"])
    for index, seen in views.items():
        if index >= 0:
            assert "neighbourhood" in seen


def test_a_part_it_cannot_place_is_looked_at_again(monkeypatch):
    provider = Provider(IDENTIFIED, named(5, 6, look=[0]), named(0))
    configure(agent_hitl="off", agent_batch=3)
    monkeypatch.setattr(naming, "ask", provider)

    first = client.post("/api/agent/start", json={"survey": chair()}).json()
    after_id = client.post("/api/agent/step", json={
        "session": first["session"], "seen": observed(first)}).json()
    again = client.post("/api/agent/step", json={
        "session": first["session"], "seen": observed(after_id)}).json()

    # The two it did name are written out; the one it could not is re-shot from
    # the angle it asked for, rather than guessed at.
    assert {p["index"] for p in again["named"]} == {5, 6}
    assert {s["index"] for s in again["shoot"]} == {0}
    assert 180 in {s["yaw"] for s in again["shoot"]}


def test_looking_again_is_bounded(monkeypatch):
    """A model that keeps asking would otherwise never finish."""
    provider = Provider(IDENTIFIED, named(5, 6, look=[0]))
    steps = run(monkeypatch, provider, agent_hitl="off", agent_batch=3)

    assert steps[-1]["finished"]
    # Once the looks are used up the request says so, so the reply has to commit.
    assert any("already looked again as often as this run allows" in said
               for said in provider.said)


def test_a_name_it_is_unsure_of_is_put_to_the_user(monkeypatch):
    provider = Provider(IDENTIFIED, named(*range(9), confidence="low"))
    configure(agent_hitl="full", agent_batch=8)
    monkeypatch.setattr(naming, "ask", provider)

    first = client.post("/api/agent/start", json={"survey": chair()}).json()
    step = to_review(first["session"], client.post("/api/agent/step", json={
        "session": first["session"], "seen": observed(first)}).json())

    assert step["phase"] == "review"
    assert step["ask"]["kind"] == "part"
    assert "shape and place" in step["ask"]["detail"]
    # The part in question is re-rendered so the question has a picture.
    assert step["ask"]["image_key"] in {s["key"] for s in step["shoot"]}


def test_the_users_word_replaces_the_agents_across_the_whole_set(monkeypatch):
    provider = Provider(IDENTIFIED, named(0, 5, 6, 7, confidence="low"))
    configure(agent_hitl="full", agent_batch=8)
    monkeypatch.setattr(naming, "ask", provider)

    first = client.post("/api/agent/start", json={"survey": chair()}).json()
    step = to_review(first["session"], client.post("/api/agent/step", json={
        "session": first["session"], "seen": observed(first)}).json())

    asked = step["ask"]["index"]
    fixed = client.post("/api/agent/step", json={
        "session": first["session"], "seen": [], "answer": "Castor Wheel"}).json()

    changed = {p["index"]: p for p in fixed["named"]}
    if asked == 0:                       # the set of five
        assert {changed[i]["name"] for i in range(5)} == {
            "Front Left Castor Wheel", "Front Right Castor Wheel",
            "Left Castor Wheel", "Right Castor Wheel", "Rear Castor Wheel"}
    # Whatever was asked about, a person has now looked at it.
    assert all(p["confidence"] == "high" for p in changed.values())


def test_answering_yes_keeps_the_name_but_settles_it(monkeypatch):
    provider = Provider(IDENTIFIED, named(0, 5, 6, 7, confidence="low"))
    configure(agent_hitl="full", agent_batch=8)
    monkeypatch.setattr(naming, "ask", provider)

    first = client.post("/api/agent/start", json={"survey": chair()}).json()
    step = to_review(first["session"], client.post("/api/agent/step", json={
        "session": first["session"], "seen": observed(first)}).json())

    was = step["ask"]["question"]
    kept = client.post("/api/agent/step", json={
        "session": first["session"], "seen": [], "answer": ""}).json()
    changed = {p["index"]: p for p in kept["named"]}
    assert any(f'"{p["name"]}"' in was for p in changed.values())
    assert all(p["confidence"] == "high" for p in changed.values())


def test_the_run_says_what_it_took_the_model_to_be(monkeypatch):
    provider = Provider(IDENTIFIED, named(*range(9)))
    steps = run(monkeypatch, provider, agent_hitl="off", agent_batch=8)
    last = steps[-1]

    assert last["finished"] and last["phase"] == "done"
    assert "high-back mesh office chair" in last["summary"]
    assert "modelling artefact" in last["summary"]
    assert last["done"] == 10


# --- the edges ---------------------------------------------------------------

def test_naming_without_a_configured_provider_explains_itself():
    reply = client.post("/api/agent/start", json={"survey": chair()})
    assert reply.status_code == 400
    assert "Settings" in reply.json()["detail"]


def test_a_run_that_has_expired_says_so_rather_than_failing_obscurely():
    configure()
    reply = client.post("/api/agent/step",
                        json={"session": "gone", "seen": []})
    assert reply.status_code == 409
    assert "expired" in reply.json()["detail"]


def test_a_run_can_be_let_go_of():
    configure()
    first = client.post("/api/agent/start", json={"survey": chair()}).json()
    assert client.delete(f"/api/agent/{first['session']}").status_code == 200
    assert client.post("/api/agent/step", json={
        "session": first["session"], "seen": []}).status_code == 409


def test_a_reply_about_a_part_that_was_not_asked_about_is_dropped(monkeypatch):
    """A model that volunteers an extra id must not write over another batch."""
    provider = Provider(IDENTIFIED, json.dumps({"parts": [
        {"id": 5, "name": "Base", "evidence": "e", "confidence": "high"},
        {"id": 99, "name": "Nonsense", "evidence": "e", "confidence": "high"},
    ]}))
    steps = run(monkeypatch, provider, agent_hitl="off", agent_batch=8)
    everything = {p["index"] for step in steps for p in step["named"]}
    assert 99 not in everything


def test_a_reply_that_is_not_json_is_reported(monkeypatch):
    configure()
    monkeypatch.setattr(naming, "ask", lambda *a, **k: "sorry, no")
    first = client.post("/api/agent/start", json={"survey": chair()}).json()
    reply = client.post("/api/agent/step", json={
        "session": first["session"], "seen": observed(first)})
    assert reply.status_code == 502
    assert "JSON" in reply.json()["detail"]


def test_a_survey_may_not_be_empty_or_enormous():
    configure()
    assert client.post("/api/agent/start", json={
        "survey": {"extents": [1, 1, 1], "base": [0, 0, 0], "parts": []},
    }).status_code == 422
    too_many = [facts(i, f"p{i}", size=(1, 1, 1), centre=(0, 0, 0))
                for i in range(agent.MAX_PARTS + 1)]
    assert client.post("/api/agent/start", json={
        "survey": {"extents": [1, 1, 1], "base": [0, 0, 0], "parts": too_many},
    }).status_code == 422


def test_the_schema_the_reply_has_to_satisfy_covers_the_evidence(monkeypatch):
    provider = Provider(IDENTIFIED, named(*range(9)))
    run(monkeypatch, provider, agent_hitl="off", agent_batch=8, describe=True)
    part = provider.schema["properties"]["parts"]["items"]
    assert set(part["required"]) == {"id", "name", "evidence", "confidence",
                                     "details"}
    assert part["properties"]["confidence"]["enum"] == list(agent.CONFIDENCE)
    assert "look_again" in provider.schema["properties"]
