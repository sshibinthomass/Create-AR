"""The settings store and the part namer.

The Azure call itself is stubbed: what these check is the wiring either side of
it -- that the key never leaves the server, that a chunk of parts turns into the
right request, and that a reply is mapped back onto the parts it was asked about.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

os.environ.setdefault("CONVERTER_DATA_DIR", str(Path(__file__).parent / "_data"))

from app import naming, settings as settings_store, vault  # noqa: E402
from app.main import app  # noqa: E402

client = TestClient(app)

# A one-pixel JPEG is enough: nothing here looks at the pixels.
PIXEL = "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBk"


@pytest.fixture(autouse=True)
def clean_settings(monkeypatch):
    """Every test starts with no saved settings and puts back what it found."""
    # The Azure variables seed a fresh install, so a developer who happens to
    # have them exported would otherwise see different defaults to CI.
    for name in ("AZURE_OPENAI_ENDPOINT", "AZURE_OPENAI_API_KEY",
                 "AZURE_OPENAI_DEPLOYMENT", "AZURE_OPENAI_API_VERSION"):
        monkeypatch.delenv(name, raising=False)
    path = settings_store.SETTINGS_PATH
    had = path.read_bytes() if path.exists() else None
    path.unlink(missing_ok=True)
    yield
    path.unlink(missing_ok=True)
    if had is not None:
        path.write_bytes(had)


def configure(**over):
    saved = settings_store.Settings(
        azure_endpoint="https://example.openai.azure.com",
        azure_key="secret-key",
        azure_deployment="gpt-4o-vision",
        **over,
    )
    settings_store.save(saved)
    return saved


def shot(index: int, name: str = "", context: str = "") -> dict:
    return {"index": index, "name": name, "isolated": PIXEL, "context": context}


# --- settings ----------------------------------------------------------------

def test_settings_start_from_the_defaults():
    body = client.get("/api/settings").json()
    assert body["mode"] == "batch"
    assert body["configured"] is False
    assert body["keys"] == {p: False for p in settings_store.PROVIDERS}
    assert body["instructions"].strip()


def test_no_api_key_ever_leaves_the_server():
    configure(openai_key="oa-key", anthropic_key="an-key")
    body = client.get("/api/settings").json()

    assert not [k for k in body if k.endswith("_key")]
    assert body["keys"] == {"azure": True, "openai": True,
                            "anthropic": True, "compatible": False}
    assert body["configured"] is True
    for secret in ("secret-key", "oa-key", "an-key"):
        assert secret not in json.dumps(body)


def test_saving_without_a_key_keeps_the_stored_one():
    configure()
    form = client.get("/api/settings").json()
    form["azure_deployment"] = "another-deployment"
    body = client.put("/api/settings", json={**form, "azure_key": ""}).json()

    assert body["keys"]["azure"] is True
    assert settings_store.load().azure_key == "secret-key"
    assert settings_store.load().azure_deployment == "another-deployment"


def test_the_key_is_only_cleared_when_asked():
    configure()
    form = client.get("/api/settings").json()
    body = client.put("/api/settings?clear_key=azure", json=form).json()

    assert body["keys"]["azure"] is False
    assert body["configured"] is False
    assert settings_store.load().azure_key == ""


def test_clearing_one_key_leaves_the_others_alone():
    configure(openai_key="oa-key", anthropic_key="an-key")
    form = client.get("/api/settings").json()
    body = client.put("/api/settings?clear_key=anthropic", json=form).json()

    assert body["keys"] == {"azure": True, "openai": True,
                            "anthropic": False, "compatible": False}


def test_switching_provider_does_not_cost_you_the_other_keys():
    configure(openai_key="oa-key")
    form = client.get("/api/settings").json()
    form["provider"] = "anthropic"
    client.put("/api/settings", json=form)

    saved = settings_store.load()
    assert saved.provider == "anthropic"
    assert saved.azure_key == "secret-key"
    assert saved.openai_key == "oa-key"


def test_clearing_a_key_for_something_that_is_not_a_provider_is_rejected():
    form = client.get("/api/settings").json()
    assert client.put("/api/settings?clear_key=nonsense", json=form).status_code == 400


@pytest.mark.parametrize("provider,fields,ready", [
    ("azure", {"azure_endpoint": "https://x", "azure_key": "k",
               "azure_deployment": "d"}, True),
    ("azure", {"azure_endpoint": "https://x", "azure_key": "k"}, False),
    ("openai", {"openai_key": "k"}, True),          # the model has a default
    ("openai", {}, False),
    ("anthropic", {"anthropic_key": "k"}, True),
    ("anthropic", {}, False),
    # A local server usually wants no key at all, so only the URL and model count.
    ("compatible", {"compatible_url": "http://localhost:11434/v1",
                    "compatible_model": "llava"}, True),
    ("compatible", {"compatible_url": "http://localhost:11434/v1"}, False),
])
def test_each_provider_knows_what_it_still_needs(provider, fields, ready):
    assert settings_store.Settings(provider=provider, **fields).configured() is ready


def test_settings_survive_a_restart_and_stay_out_of_the_repo():
    configure(batch_size=11)
    assert settings_store.load().batch_size == 11
    # The data directory is git-ignored, which is the whole reason it is here.
    assert settings_store.SETTINGS_PATH.is_relative_to(settings_store.config.DATA_DIR)


def test_every_setting_comes_back_after_a_restart():
    """The point of the file: nothing typed on the page is typed twice."""
    configure(provider="openai", openai_key="sk-typed-once", openai_model="gpt-5",
              mode="single", batch_size=7, concurrency=2, context_shot=False,
              describe=False, instructions="house style")
    again = settings_store.load()
    assert (again.provider, again.openai_model, again.mode) == ("openai", "gpt-5", "single")
    assert (again.batch_size, again.concurrency) == (7, 2)
    assert (again.context_shot, again.describe) == (False, False)
    assert again.instructions == "house style"
    assert again.openai_key == "sk-typed-once"


def test_the_keys_are_encrypted_on_disk():
    configure(openai_key="sk-plain-text-please-no")
    raw = settings_store.SETTINGS_PATH.read_text("utf-8")
    assert "sk-plain-text-please-no" not in raw
    assert "secret-key" not in raw          # the azure one configure() sets
    assert json.loads(raw)["openai_key"].startswith(vault.PREFIX)
    # ...and are perfectly readable to the app itself.
    assert settings_store.load().openai_key == "sk-plain-text-please-no"


def test_a_plaintext_file_from_an_older_build_is_sealed_on_first_load():
    configure()
    stale = json.loads(settings_store.SETTINGS_PATH.read_text("utf-8"))
    stale["azure_key"] = "written-before-we-encrypted"
    settings_store.SETTINGS_PATH.write_text(json.dumps(stale), encoding="utf-8")

    assert settings_store.load().azure_key == "written-before-we-encrypted"
    # Reading it was enough to upgrade it; nobody had to press Save.
    raw = settings_store.SETTINGS_PATH.read_text("utf-8")
    assert "written-before-we-encrypted" not in raw
    assert json.loads(raw)["azure_key"].startswith(vault.PREFIX)


def test_a_key_that_will_not_decrypt_reads_as_absent(monkeypatch):
    """A data directory copied without its key, or a rotated master key.

    Reporting the key as missing is both true and fixable by typing it again;
    raising here would take the whole settings page down instead.
    """
    configure(provider="openai", openai_key="sk-sealed-with-the-old-key")
    monkeypatch.setenv(vault.ENV_MASTER_KEY,
                       vault.Fernet.generate_key().decode("ascii"))
    vault.forget_cipher()
    try:
        lost = settings_store.load()
        assert lost.openai_key == ""
        assert lost.configured() is False
        assert lost.public()["keys"]["openai"] is False
    finally:
        monkeypatch.delenv(vault.ENV_MASTER_KEY, raising=False)
        vault.forget_cipher()


def test_the_master_key_can_live_outside_the_data_directory(monkeypatch):
    monkeypatch.setenv(vault.ENV_MASTER_KEY,
                       vault.Fernet.generate_key().decode("ascii"))
    vault.forget_cipher()
    try:
        assert vault.key_location() is None
        sealed = vault.seal("sk-held-elsewhere")
        assert vault.unseal(sealed) == "sk-held-elsewhere"
    finally:
        monkeypatch.delenv(vault.ENV_MASTER_KEY, raising=False)
        vault.forget_cipher()
    # Back on the key file, the value sealed with the env key is unreadable --
    # which is the point of having put it somewhere else.
    assert vault.key_location() == settings_store.config.SECRET_KEY_PATH


def test_sealing_leaves_an_empty_key_empty():
    # An empty field means "no key", and must not become ciphertext that
    # decrypts to nothing -- `public()` reports on truthiness.
    assert vault.seal("") == ""
    assert vault.unseal("") == ""


def test_a_corrupt_settings_file_falls_back_to_the_defaults():
    settings_store.SETTINGS_PATH.write_text("{ not json", encoding="utf-8")
    assert settings_store.load().mode == "batch"


def test_a_key_the_user_never_typed_here_is_not_adopted(monkeypatch):
    """OPENAI_API_KEY and ANTHROPIC_API_KEY are set machine-wide by all sorts of
    unrelated tools. Reading one would persist it on the first save and show
    this app as ready to spend against it."""
    monkeypatch.setenv("OPENAI_API_KEY", "someone-elses-key")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "someone-elses-key")
    loaded = settings_store.load()
    assert loaded.openai_key == ""
    assert loaded.anthropic_key == ""


def test_the_azure_variables_do_seed_a_fresh_install(monkeypatch):
    monkeypatch.setenv("AZURE_OPENAI_ENDPOINT", "https://from-the-environment")
    monkeypatch.setenv("AZURE_OPENAI_API_KEY", "env-key")
    assert settings_store.load().azure_endpoint == "https://from-the-environment"

    # ...but a value typed into the page wins from then on.
    settings_store.save(settings_store.Settings(azure_endpoint="https://typed-in"))
    assert settings_store.load().azure_endpoint == "https://typed-in"


def test_out_of_range_settings_are_rejected():
    form = client.get("/api/settings").json()
    assert client.put("/api/settings", json={**form, "batch_size": 900}).status_code == 422
    assert client.put("/api/settings", json={**form, "mode": "sideways"}).status_code == 422
    assert client.put("/api/settings", json={**form, "provider": "gemini"}).status_code == 422


# --- naming ------------------------------------------------------------------

def test_naming_without_a_configured_provider_explains_itself():
    reply = client.post("/api/name-parts", json={"parts": [shot(0)], "total": 1})
    assert reply.status_code == 400
    assert "Settings" in reply.json()["detail"]


def test_naming_maps_the_reply_back_onto_the_parts(monkeypatch):
    configure()
    seen = {}

    def stub(request, settings):
        seen["request"] = request
        seen["settings"] = settings
        return {0: {"name": "Front Wheel", "details": {}},
                1: {"name": "Hex Bolt", "details": {"Purpose": "Holds it on"}}}

    monkeypatch.setattr(naming, "name_parts", stub)
    body = client.post("/api/name-parts", json={
        "parts": [shot(0, "Mesh_001"), shot(1, "Mesh_002", context=PIXEL)],
        "total": 2,
        "taken": ["Chassis"],
    }).json()

    assert body["names"] == [
        {"index": 0, "name": "Front Wheel", "details": {}},
        {"index": 1, "name": "Hex Bolt", "details": {"Purpose": "Holds it on"}},
    ]
    assert seen["settings"].model() == "gpt-4o-vision"
    assert [p.name for p in seen["request"].parts] == ["Mesh_001", "Mesh_002"]
    assert seen["request"].taken == ["Chassis"]


def test_a_failing_deployment_comes_back_as_a_bad_gateway(monkeypatch):
    configure()

    def boom(request, settings):
        raise naming.NamingError("deployment not found")

    monkeypatch.setattr(naming, "name_parts", boom)
    reply = client.post("/api/name-parts", json={"parts": [shot(0)], "total": 1})
    assert reply.status_code == 502
    assert "deployment not found" in reply.json()["detail"]


def test_a_chunk_may_not_be_empty_or_enormous():
    configure()
    assert client.post("/api/name-parts", json={"parts": [], "total": 1}).status_code == 422
    too_many = [shot(i) for i in range(naming.MAX_PARTS_PER_CALL + 1)]
    assert client.post("/api/name-parts",
                       json={"parts": too_many, "total": 99}).status_code == 422


# --- what actually goes to the deployment, and what comes back ---------------

def test_every_part_contributes_its_pictures_and_the_reply_format_is_pinned():
    request = naming.NameRequest(parts=[shot(3, "Mesh_003", context=PIXEL), shot(7)],
                                 total=40, taken=["Chassis", "Lid"])
    blocks = naming._blocks(request)

    images = [b for b in blocks if b["type"] == "image_url"]
    assert len(images) == 3  # two for the part with context, one for the other
    assert all(b["image_url"]["url"].startswith("data:image/jpeg;base64,") for b in images)

    text = " ".join(b["text"] for b in blocks if b["type"] == "text")
    assert "Part id 3, one of 40 in this model" in text
    assert '"Mesh_003"' in text          # the file's own name, as a hint
    assert "Chassis, Lid" in text        # names already handed out
    assert "these ids: 3, 7" in text     # exactly what the reply must cover


def test_only_the_ids_that_were_asked_about_are_accepted():
    request = naming.NameRequest(parts=[shot(0), shot(1)], total=2)
    reply = json.dumps({"parts": [
        {"id": 0, "name": "  Front   Wheel  "},   # whitespace collapses
        {"id": 1, "name": ""},                    # empty is not a name
        {"id": 9, "name": "Not Asked For"},       # not in this chunk
    ]})
    assert naming._read(reply, request) == {0: {"name": "Front Wheel", "details": {}}}


def test_an_overlong_name_is_cut_to_something_the_list_can_show():
    request = naming.NameRequest(parts=[shot(0)], total=1)
    reply = json.dumps({"parts": [{"id": 0, "name": "Bracket " * 100}]})
    assert len(naming._read(reply, request)[0]["name"]) <= naming.MAX_NAME_LEN


@pytest.mark.parametrize("reply", ["not json at all", '{"parts": "nope"}',
                                   '{"parts": []}'])
def test_an_unusable_reply_is_reported_rather_than_guessed_at(reply):
    request = naming.NameRequest(parts=[shot(0)], total=1)
    with pytest.raises(naming.NamingError):
        naming._read(reply, request)


# --- the four providers -------------------------------------------------------

class _FakeOpenAI:
    """Records the call and answers with one name, like a chat deployment."""

    sent: dict = {}

    def __init__(self, **kwargs):
        _FakeOpenAI.sent = {"client": kwargs}
        self.chat = type("Chat", (), {"completions": self})

    def create(self, **kwargs):
        _FakeOpenAI.sent.update(kwargs)
        message = type("M", (), {"content": '{"parts":[{"id":5,"name":"Idler Pulley"}]}'})
        return type("R", (), {"choices": [type("C", (), {"message": message})]})


def test_azure_is_called_at_its_deployment_with_the_instructions(monkeypatch):
    import openai
    monkeypatch.setattr(openai, "AzureOpenAI", _FakeOpenAI)

    saved = configure(instructions="Name it plainly.")
    request = naming.NameRequest(parts=[shot(5)], total=1)
    assert naming.name_parts(request, saved) == {5: {"name": "Idler Pulley", "details": {}}}

    sent = _FakeOpenAI.sent
    assert sent["client"]["azure_endpoint"] == "https://example.openai.azure.com"
    assert sent["client"]["api_key"] == "secret-key"
    assert sent["model"] == "gpt-4o-vision"          # the deployment, not a model name
    assert sent["response_format"] == {"type": "json_object"}
    assert sent["messages"][0] == {"role": "system", "content": "Name it plainly."}


class _PickyOpenAI(_FakeOpenAI):
    """A model that refuses max_tokens, then temperature, then answers.

    Exactly what the o-series and GPT-5 do, and exactly what DeepSeek and the
    other OpenAI-compatible servers do not -- which is why the parameters are
    discovered from the refusal rather than from the model's name.
    """

    refuse: tuple = ()
    calls: list = []

    def create(self, **kwargs):
        _PickyOpenAI.calls.append(dict(kwargs))
        import openai
        if "max_tokens" in _PickyOpenAI.refuse and "max_tokens" in kwargs:
            raise openai.BadRequestError(
                "Error code: 400", response=_response(), body={"error": {
                    "message": ("Unsupported parameter: 'max_tokens' is not "
                                "supported with this model. Use "
                                "'max_completion_tokens' instead."),
                    "type": "invalid_request_error",
                    "param": "max_tokens", "code": "unsupported_parameter"}})
        if "temperature" in _PickyOpenAI.refuse and "temperature" in kwargs:
            raise openai.BadRequestError(
                "Error code: 400", response=_response(), body={"error": {
                    "message": ("Unsupported value: 'temperature' does not "
                                "support 0.2 with this model."),
                    "type": "invalid_request_error",
                    "param": "temperature", "code": "unsupported_value"}})
        return super().create(**kwargs)


def _response():
    import httpx
    return httpx.Response(400, request=httpx.Request("POST", "https://example"))


@pytest.fixture(autouse=True)
def _forget_quirks():
    naming._quirks.clear()
    _PickyOpenAI.calls = []
    _PickyOpenAI.refuse = ()
    yield
    naming._quirks.clear()


def test_a_model_that_wants_max_completion_tokens_gets_it(monkeypatch):
    """The o-series and GPT-5 renamed the parameter; the retry finds that out."""
    import openai
    _PickyOpenAI.refuse = ("max_tokens",)
    monkeypatch.setattr(openai, "OpenAI", _PickyOpenAI)

    saved = settings_store.Settings(provider="openai", openai_key="oa-key",
                                    openai_model="gpt-5")
    got = naming.name_parts(naming.NameRequest(parts=[shot(5)], total=1), saved)
    assert got == {5: {"name": "Idler Pulley", "details": {}}}

    first, second = _PickyOpenAI.calls
    assert "max_tokens" in first and "max_completion_tokens" not in first
    assert "max_tokens" not in second
    assert second["max_completion_tokens"] == first["max_tokens"]


def test_a_model_that_also_refuses_temperature_is_asked_without_it(monkeypatch):
    import openai
    _PickyOpenAI.refuse = ("max_tokens", "temperature")
    monkeypatch.setattr(openai, "OpenAI", _PickyOpenAI)

    saved = settings_store.Settings(provider="openai", openai_key="oa-key",
                                    openai_model="o3")
    naming.name_parts(naming.NameRequest(parts=[shot(5)], total=1), saved)
    last = _PickyOpenAI.calls[-1]
    assert "temperature" not in last
    assert "max_completion_tokens" in last


def test_what_the_model_refused_is_remembered_for_the_next_chunk(monkeypatch):
    """A naming run is many requests. Rediscovering this on each would double
    every one of them."""
    import openai
    _PickyOpenAI.refuse = ("max_tokens",)
    monkeypatch.setattr(openai, "OpenAI", _PickyOpenAI)

    saved = settings_store.Settings(provider="openai", openai_key="oa-key",
                                    openai_model="gpt-5")
    for _ in range(3):
        naming.name_parts(naming.NameRequest(parts=[shot(5)], total=1), saved)
    # One wasted call on the first chunk, and none after it.
    assert len(_PickyOpenAI.calls) == 4


def test_a_model_that_takes_max_tokens_is_left_alone(monkeypatch):
    """DeepSeek and the other compatible servers only know max_tokens."""
    import openai
    monkeypatch.setattr(openai, "OpenAI", _PickyOpenAI)

    saved = settings_store.Settings(
        provider="compatible", compatible_url="https://api.deepseek.com",
        compatible_model="deepseek-chat", compatible_key="ds-key")
    naming.name_parts(naming.NameRequest(parts=[shot(5)], total=1), saved)

    only = _PickyOpenAI.calls[0]
    assert len(_PickyOpenAI.calls) == 1
    assert only["max_tokens"] and only["temperature"] == 0.2
    assert "max_completion_tokens" not in only


def test_a_refusal_that_is_not_about_a_parameter_is_reported(monkeypatch):
    """Retrying a bad key or a missing model would only fail again, slower."""
    import openai

    class _Broken(_FakeOpenAI):
        def create(self, **kwargs):
            raise openai.BadRequestError(
                "Error code: 400", response=_response(), body={"error": {
                    "message": "The model `nope` does not exist.",
                    "code": "model_not_found", "param": None}})

    monkeypatch.setattr(openai, "OpenAI", _Broken)
    saved = settings_store.Settings(provider="openai", openai_key="oa-key",
                                    openai_model="nope")
    with pytest.raises(naming.NamingError, match="does not exist"):
        naming.name_parts(naming.NameRequest(parts=[shot(5)], total=1), saved)


def test_openai_proper_uses_its_own_base_url(monkeypatch):
    import openai
    monkeypatch.setattr(openai, "OpenAI", _FakeOpenAI)

    saved = settings_store.Settings(provider="openai", openai_key="oa-key",
                                    openai_model="gpt-4o")
    naming.name_parts(naming.NameRequest(parts=[shot(5)], total=1), saved)

    sent = _FakeOpenAI.sent
    assert sent["client"]["api_key"] == "oa-key"
    assert sent["client"]["base_url"] is None        # the SDK's own endpoint
    assert sent["model"] == "gpt-4o"


def test_a_compatible_endpoint_is_called_at_the_url_it_was_given(monkeypatch):
    import openai
    monkeypatch.setattr(openai, "OpenAI", _FakeOpenAI)

    saved = settings_store.Settings(provider="compatible", compatible_model="llava",
                                    compatible_url="http://localhost:11434/v1")
    naming.name_parts(naming.NameRequest(parts=[shot(5)], total=1), saved)

    sent = _FakeOpenAI.sent
    assert sent["client"]["base_url"] == "http://localhost:11434/v1"
    assert sent["model"] == "llava"
    # A local server that wants no key still has to get *something* past the SDK,
    # which refuses to construct a client without one.
    assert sent["client"]["api_key"] == "unused"


def test_anthropic_gets_claude_shaped_images_and_a_schema(monkeypatch):
    import anthropic
    sent = {}

    class FakeAnthropic:
        def __init__(self, **kwargs):
            sent["client"] = kwargs
            self.messages = self

        def create(self, **kwargs):
            sent.update(kwargs)
            block = type("B", (), {"type": "text",
                                   "text": '{"parts":[{"id":5,"name":"Idler Pulley"}]}'})
            return type("R", (), {"content": [block], "stop_reason": "end_turn"})

    monkeypatch.setattr(anthropic, "Anthropic", FakeAnthropic)

    saved = settings_store.Settings(provider="anthropic", anthropic_key="an-key",
                                    instructions="Name it plainly.")
    request = naming.NameRequest(parts=[shot(5, context=PIXEL)], total=1)
    assert naming.name_parts(request, saved) == {5: {"name": "Idler Pulley", "details": {}}}

    assert sent["client"]["api_key"] == "an-key"
    assert sent["model"] == "claude-opus-5"
    # The system prompt is its own argument here, not the first message.
    assert sent["system"] == "Name it plainly."
    assert sent["output_config"]["format"]["schema"] == naming.reply_schema(False)

    images = [b for b in sent["messages"][0]["content"] if b["type"] == "image"]
    assert len(images) == 2
    assert all(b["source"]["type"] == "base64" for b in images)
    assert all(b["source"]["media_type"] == "image/jpeg" for b in images)


def test_a_refusal_is_reported_rather_than_read_as_a_name(monkeypatch):
    import anthropic

    class FakeAnthropic:
        def __init__(self, **kwargs):
            self.messages = self

        def create(self, **kwargs):
            return type("R", (), {"content": [], "stop_reason": "refusal"})

    monkeypatch.setattr(anthropic, "Anthropic", FakeAnthropic)

    saved = settings_store.Settings(provider="anthropic", anthropic_key="an-key")
    with pytest.raises(naming.NamingError, match="declined"):
        naming.name_parts(naming.NameRequest(parts=[shot(0)], total=1), saved)


def test_a_deployment_that_errors_is_wrapped_rather_than_raised_raw(monkeypatch):
    import openai

    class FakeClient:
        def __init__(self, **kwargs):
            self.chat = type("Chat", (), {"completions": self})

        def create(self, **kwargs):
            raise openai.OpenAIError("the deployment does not exist")

    monkeypatch.setattr(openai, "AzureOpenAI", FakeClient)

    with pytest.raises(naming.NamingError, match="does not exist"):
        naming.name_parts(naming.NameRequest(parts=[shot(0)], total=1), configure())
