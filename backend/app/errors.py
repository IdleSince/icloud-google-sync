"""Error codes shared by API, sync engine and logs.

The UI translates codes; the backend never returns human-readable text.
"""

from __future__ import annotations

from typing import Any


class AppError(Exception):
    """An error with a stable machine code and an HTTP status for the API layer."""

    def __init__(self, code: str, status_code: int = 400, params: dict[str, Any] | None = None) -> None:
        super().__init__(code)
        self.code = code
        self.status_code = status_code
        self.params = params or {}

    def to_dict(self) -> dict[str, Any]:
        return {"code": self.code, "params": self.params}


# iCloud
class ICloudError(AppError):
    pass


class ICloudAuthError(ICloudError):
    def __init__(self) -> None:
        super().__init__("icloud.auth_failed", 400)


class ICloudUnreachable(ICloudError):
    def __init__(self, params: dict[str, Any] | None = None) -> None:
        super().__init__("icloud.unreachable", 502, params)


class ICloudUnexpected(ICloudError):
    def __init__(self, params: dict[str, Any] | None = None) -> None:
        super().__init__("icloud.unexpected_response", 502, params)


# Google
class GoogleError(AppError):
    pass


class GoogleReauthRequired(GoogleError):
    def __init__(self) -> None:
        super().__init__("google.reauth_required", 409)


class GoogleApiError(GoogleError):
    def __init__(self, status: int, reason: str | None = None) -> None:
        params: dict[str, Any] = {"status": status}
        if reason:
            params["reason"] = reason
        super().__init__("google.api_error", 502, params)
        self.http_status = status
        self.reason = reason


class GoogleRateLimited(GoogleError):
    def __init__(self) -> None:
        super().__init__("google.rate_limited", 429)
