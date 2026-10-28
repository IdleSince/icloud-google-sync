"""Authenticated encryption for credentials and tokens stored in SQLite.

AES-256-GCM with a random 96-bit nonce. The column/purpose name is bound as
associated data so a ciphertext copied into another column fails to decrypt.
Format: ``v1.<base64url(nonce || ciphertext+tag)>``.
"""

from __future__ import annotations

import base64
import hashlib
import os
import secrets

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from .config import get_settings

_PREFIX = "v1."


class DecryptionError(Exception):
    pass


def _aead() -> AESGCM:
    return AESGCM(get_settings().encryption_key_bytes())


def encrypt(plaintext: str, purpose: str) -> str:
    nonce = os.urandom(12)
    data = _aead().encrypt(nonce, plaintext.encode("utf-8"), purpose.encode("utf-8"))
    return _PREFIX + base64.urlsafe_b64encode(nonce + data).decode("ascii")


def decrypt(token: str, purpose: str) -> str:
    if not token.startswith(_PREFIX):
        raise DecryptionError("unknown ciphertext version")
    raw = base64.urlsafe_b64decode(token[len(_PREFIX) :])
    try:
        return _aead().decrypt(raw[:12], raw[12:], purpose.encode("utf-8")).decode("utf-8")
    except InvalidTag as exc:  # wrong key or tampered data
        raise DecryptionError("ciphertext could not be authenticated") from exc


def random_token(nbytes: int = 32) -> str:
    return secrets.token_urlsafe(nbytes)


def sha256_hex(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def generate_key() -> str:
    """Helper for operators: ``python -m app.crypto`` prints a fresh key."""
    return base64.urlsafe_b64encode(os.urandom(32)).decode("ascii").rstrip("=")


if __name__ == "__main__":
    print(generate_key())
