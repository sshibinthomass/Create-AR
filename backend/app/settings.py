"""Persisted settings for the part namer.

The file lives in the data directory rather than the repo. That directory is
already git-ignored and is already the thing a deployment points at a volume,
which is what this needs: the settings hold an Azure OpenAI key, so they must
survive a restart without ever being committed.

Environment variables seed whatever the file does not already say, so a
container can be configured without anyone opening the settings panel, while a
value typed into the panel wins from then on.
"""

from __future__ import annotations

import json
import os

from pydantic import BaseModel, Field, ValidationError

from . import config

SETTINGS_PATH = config.DATA_DIR / "settings.json"

# The editable half of the prompt. The JSON contract the reply has to satisfy is
# *not* here -- it is built alongside the images in naming.py, so that rewriting
# these instructions cannot break the parsing.
#
# Written as unwrapped paragraphs rather than a wrapped block: it is edited in a
# textarea, and source-wrapped lines come out ragged at every width but the one
# they were wrapped for.
DEFAULT_INSTRUCTIONS = (
    "You are naming the parts of a 3D model for an engineer browsing an "
    "assembly."
    "\n\n"
    "Each part is shown to you on its own against a plain background, and -- "
    "when the second image is present -- highlighted in orange inside the whole "
    "assembly, so you can see where it sits and what it meets. Most parts also "
    "carry the name the modelling tool gave them, which is usually noise like "
    '"Mesh_014" or "Cube.003" but is occasionally a real name worth keeping.'
    "\n\n"
    "Give each part a short, concrete name: what the thing is, in one to four "
    "words, in Title Case. Prefer the specific term to the generic one -- "
    '"Hex Bolt" rather than "Fastener", "Front Wheel" rather than "Round Part" '
    "-- and name a part by the job it does in this assembly wherever the "
    "context image makes that clear. If you genuinely cannot tell what a part "
    'is, describe its shape plainly ("Curved Bracket") rather than inventing a '
    "function for it. Do not number parts unless the number is what tells two "
    "otherwise identical parts apart."
)


PROVIDERS = ("azure", "openai", "anthropic", "compatible")
_PROVIDER_PATTERN = "^(" + "|".join(PROVIDERS) + ")$"

# Which key belongs to which provider. Every one is kept even while another is
# selected, so trying Anthropic for an afternoon does not cost you the Azure key
# you had typed in.
KEY_FIELDS = {
    "azure": "azure_key",
    "openai": "openai_key",
    "anthropic": "anthropic_key",
    "compatible": "compatible_key",
}


# Added to the instructions above only when descriptions are asked for, so the
# naming prompt stays exactly as short as it was when they are not.
DESCRIBE_INSTRUCTIONS = (
    "As well as naming each part, describe it. Fill in a \"details\" object of "
    "labelled notes: always \"What it is\", \"What it does\", \"How it is used\" "
    "and \"Purpose\", then whatever else genuinely applies to this particular "
    "part -- what it is made of, where it sits, what it fastens to, how it "
    "comes off, what wears out first. Use plain English labels and one or two "
    "sentences each."
    "\n\n"
    "Add a label only when you have something real to say under it: a bearing "
    "and a wiring loom are worth different notes, and a fixed list of headings "
    "would have you padding one and cramping the other. Say when you are unsure "
    "rather than inventing a use for a part you cannot identify."
)


class Settings(BaseModel):
    """Everything the naming feature needs, all of it editable from the page."""

    provider: str = Field("azure", pattern=_PROVIDER_PATTERN)

    # Azure OpenAI. The deployment is the *deployment name*, not the model name.
    azure_endpoint: str = Field("", max_length=400)
    azure_key: str = Field("", max_length=400)
    azure_deployment: str = Field("", max_length=200)
    azure_api_version: str = Field("2024-10-21", max_length=40)

    # OpenAI proper.
    openai_key: str = Field("", max_length=400)
    openai_model: str = Field("gpt-4o", max_length=200)

    # Anthropic proper.
    anthropic_key: str = Field("", max_length=400)
    anthropic_model: str = Field("claude-opus-5", max_length=200)

    # Anything else that speaks the OpenAI chat-completions API at a URL of your
    # own -- a local llama.cpp or vLLM server, a gateway, a router. The key is
    # optional here because plenty of local servers do not ask for one.
    compatible_url: str = Field("", max_length=400)
    compatible_key: str = Field("", max_length=400)
    compatible_model: str = Field("", max_length=200)

    # How the parts are handed over: one request each, or several to a request.
    mode: str = Field("batch", pattern="^(single|batch)$")
    batch_size: int = Field(8, ge=1, le=24)
    # Requests the browser keeps in flight at once.
    concurrency: int = Field(3, ge=1, le=8)
    # Send the second image -- the part highlighted in the whole assembly.
    context_shot: bool = True
    # Ask for a description of each part as well as a name. Off, the run only
    # renames; on, it also fills the parts document that ships in a bundle.
    describe: bool = True

    instructions: str = Field(DEFAULT_INSTRUCTIONS, max_length=4000)
    describe_instructions: str = Field(DESCRIBE_INSTRUCTIONS, max_length=4000)

    def model(self) -> str:
        """What to ask for, by whatever name the chosen provider calls it."""
        return {
            "azure": self.azure_deployment,
            "openai": self.openai_model,
            "anthropic": self.anthropic_model,
            "compatible": self.compatible_model,
        }[self.provider]

    def key(self) -> str:
        return getattr(self, KEY_FIELDS[self.provider])

    def configured(self) -> bool:
        """Does the *selected* provider have everything it needs?"""
        if self.provider == "azure":
            return bool(self.azure_endpoint and self.azure_key and self.azure_deployment)
        if self.provider == "compatible":
            return bool(self.compatible_url and self.compatible_model)
        return bool(self.key() and self.model())

    def public(self) -> dict:
        """Everything the browser may see. No key ever goes back out."""
        data = {k: v for k, v in self.model_dump().items()
                if k not in KEY_FIELDS.values()}
        data["keys"] = {name: bool(getattr(self, field))
                        for name, field in KEY_FIELDS.items()}
        data["configured"] = self.configured()
        return data


# Only the Azure variables are read, and deliberately so. They name one
# specific service and nothing else on a machine sets them, whereas
# OPENAI_API_KEY and ANTHROPIC_API_KEY are set machine-wide by all manner of
# unrelated tools -- an editor, a shell profile, another agent. Adopting one of
# those would put a key the user never typed here into settings.json on the
# first save, and show this app as ready to spend against it. Those keys are
# typed on the settings page instead.
_ENV = {
    "azure_endpoint": "AZURE_OPENAI_ENDPOINT",
    "azure_key": "AZURE_OPENAI_API_KEY",
    "azure_deployment": "AZURE_OPENAI_DEPLOYMENT",
    "azure_api_version": "AZURE_OPENAI_API_VERSION",
}


def _from_env() -> dict:
    return {field: value for field, name in _ENV.items()
            if (value := os.environ.get(name))}


def load() -> Settings:
    """Read the saved settings, falling back to the environment and defaults."""
    try:
        saved = json.loads(SETTINGS_PATH.read_text("utf-8"))
    except (OSError, json.JSONDecodeError):
        saved = {}
    if not isinstance(saved, dict):
        saved = {}
    try:
        return Settings(**{**_from_env(), **saved})
    except ValidationError:
        # A hand-edited or half-written file should not take the app down with
        # it; the panel will show the defaults and overwrite it on the next save.
        return Settings(**_from_env())


def save(settings: Settings) -> None:
    config.ensure_dirs()
    scratch = SETTINGS_PATH.with_suffix(".json.tmp")
    scratch.write_text(json.dumps(settings.model_dump(), indent=2), "utf-8")
    os.replace(scratch, SETTINGS_PATH)
    try:
        SETTINGS_PATH.chmod(0o600)
    except OSError:
        pass  # Windows and most container filesystems do not honour this.
