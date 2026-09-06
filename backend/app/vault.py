"""Encrypting the API keys that settings.json holds.

The settings file has to survive a restart, so the keys in it have to be on
disk somewhere. Writing them in the clear means every copy of that file is a
copy of the key -- a backup, a synced folder, a `cat settings.json` pasted into
a bug report, a container image built with the data directory in it. Sealing
them turns all of those into ciphertext.

What this does *not* do is protect a key from someone who can already read the
data directory: the master key lives there too, and has to, or the app could
not start unattended. That is the deliberate trade. Set ``CONVERTER_SECRET_KEY``
to hold the master key somewhere else -- a real secret store, a systemd
credential, a Docker secret -- and nothing on disk decrypts on its own.

Nothing here reaches the network. The keys are read back only to be handed to
the provider the user chose, and never to the browser.
"""

from __future__ import annotations

import os
from pathlib import Path

from cryptography.fernet import Fernet, InvalidToken

from . import config

# Sealed values carry their scheme, so a plaintext file written by an older
# build is still readable and can be told apart from ciphertext on sight.
PREFIX = "enc:v1:"

ENV_MASTER_KEY = "CONVERTER_SECRET_KEY"

_cipher: Fernet | None = None


def _master_key() -> bytes:
    """The Fernet key, from the environment or from a file beside the settings.

    The environment wins, so a deployment can keep the key out of the data
    directory entirely. Otherwise one is generated on first use and written
    with owner-only permissions -- which POSIX honours and Windows ignores, the
    same caveat the settings file itself carries.
    """
    supplied = os.environ.get(ENV_MASTER_KEY, "").strip()
    if supplied:
        return supplied.encode("utf-8")

    path = config.SECRET_KEY_PATH
    try:
        held = path.read_bytes().strip()
        if held:
            return held
    except OSError:
        pass

    config.ensure_dirs()
    fresh = Fernet.generate_key()
    # Written through a scratch file so a crash mid-write cannot leave a
    # truncated key behind, which would strand every value already sealed.
    scratch = path.with_suffix(".key.tmp")
    scratch.write_bytes(fresh)
    try:
        scratch.chmod(0o600)
    except OSError:
        pass
    os.replace(scratch, path)
    return fresh


def _fernet() -> Fernet:
    global _cipher
    if _cipher is None:
        _cipher = Fernet(_master_key())
    return _cipher


def forget_cipher() -> None:
    """Drop the cached cipher, so the next call re-reads the master key."""
    global _cipher
    _cipher = None


def is_sealed(value: str) -> bool:
    return isinstance(value, str) and value.startswith(PREFIX)


def seal(value: str) -> str:
    """Encrypt one secret. Empty stays empty -- there is nothing to hide."""
    if not value:
        return ""
    if is_sealed(value):
        return value
    return PREFIX + _fernet().encrypt(value.encode("utf-8")).decode("ascii")


def unseal(value: str) -> str:
    """Decrypt one secret, or pass through a plaintext one from an older file.

    A value that will not decrypt -- the master key was replaced, the file was
    truncated, the data directory was copied without its key -- is reported as
    absent rather than raising. The settings page then shows that provider as
    having no key, which is both true and fixable by typing it again; the
    alternative is a settings page that will not load at all.
    """
    if not value:
        return ""
    if not is_sealed(value):
        return value
    try:
        return _fernet().decrypt(value[len(PREFIX):].encode("ascii")).decode("utf-8")
    except (InvalidToken, ValueError):
        return ""


def key_location() -> Path | None:
    """Where the master key is kept, or None when the environment supplies it."""
    return None if os.environ.get(ENV_MASTER_KEY, "").strip() else config.SECRET_KEY_PATH
