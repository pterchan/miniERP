from __future__ import annotations

import base64
import hashlib
import hmac
import os
import secrets
from datetime import datetime, timedelta, timezone

try:  # argon2-cffi is installed by the container image
    from argon2 import PasswordHasher
    from argon2.exceptions import InvalidHashError, VerifyMismatchError
except ImportError:  # pragma: no cover - local minimal environments
    PasswordHasher = None
    InvalidHashError = VerifyMismatchError = Exception


_ARGON2 = PasswordHasher() if PasswordHasher else None


def hash_password(password: str) -> str:
    if not password or len(password) < 8:
        raise ValueError("password must contain at least 8 characters")
    if _ARGON2:
        return _ARGON2.hash(password)
    salt = os.urandom(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, 220_000)
    return "pbkdf2_sha256$220000$%s$%s" % (
        base64.urlsafe_b64encode(salt).decode(),
        base64.urlsafe_b64encode(digest).decode(),
    )


def verify_password(password: str, encoded: str) -> bool:
    if encoded.startswith("$argon2") and _ARGON2:
        try:
            return bool(_ARGON2.verify(encoded, password))
        except (VerifyMismatchError, InvalidHashError):
            return False
    try:
        scheme, rounds, salt, expected = encoded.split("$", 3)
        if scheme != "pbkdf2_sha256":
            return False
        digest = hashlib.pbkdf2_hmac("sha256", password.encode(), base64.urlsafe_b64decode(salt), int(rounds))
        return hmac.compare_digest(base64.urlsafe_b64encode(digest).decode(), expected)
    except (ValueError, TypeError):
        return False


def random_token() -> str:
    return secrets.token_urlsafe(32)


def token_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def utc_after(hours: int = 12) -> datetime:
    return datetime.now(timezone.utc) + timedelta(hours=hours)
