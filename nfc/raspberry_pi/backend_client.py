"""The tag writer's side of the KYRA backend's device API (backend/src/routes/nfc.js), with the device token.

Retries network errors and 5xx answers with backoff; never logs the token or full URLs.
"""

from __future__ import annotations

import json
import logging
import time
import urllib.error
import urllib.request

log = logging.getLogger("kyra.nfc.backend")


class BackendError(RuntimeError):
    """The backend couldn't be reached, or refused the request."""

    def __init__(self, message: str, status: int | None = None):
        super().__init__(message)
        self.status = status


class BackendClient:
    def __init__(self, base_url: str, token: str, device_id: str, timeout: float = 8, retries: int = 3, backoff: float = 1.0):
        self.base_url = base_url.rstrip("/")
        self.token = token
        self.device_id = device_id
        self.timeout = timeout
        self.retries = retries
        self.backoff = backoff

    def _request(self, method: str, path: str, body: dict | None = None):
        data = json.dumps(body).encode() if body is not None else None
        headers = {"Authorization": f"Bearer {self.token}", "Accept": "application/json"}
        if data is not None:
            headers["Content-Type"] = "application/json"
        last = None
        for attempt in range(self.retries + 1):
            request = urllib.request.Request(f"{self.base_url}{path}", data=data, method=method, headers=headers)
            try:
                with urllib.request.urlopen(request, timeout=self.timeout) as response:
                    raw = response.read()
                    return response.status, (json.loads(raw) if raw else None)
            except urllib.error.HTTPError as error:
                if error.code < 500:
                    try:
                        detail = json.loads(error.read() or b"{}").get("error", "")
                    except ValueError:
                        detail = ""
                    raise BackendError(f"{method} {path.split('?')[0]}: {error.code} {detail}".strip(), error.code) from None
                last = BackendError(f"backend answered {error.code}", error.code)
            except (urllib.error.URLError, TimeoutError, ConnectionError, OSError) as error:
                last = BackendError(f"backend unreachable: {getattr(error, 'reason', error)}")
            if attempt < self.retries:
                time.sleep(self.backoff * (2 ** attempt))
        raise last

    def next_job(self):
        """{jobId, url, status} for this device, or None when there's nothing to write."""
        status, body = self._request("GET", f"/api/v2/nfc/device/next?deviceId={urllib.request.quote(self.device_id)}")
        return body if status == 200 and body else None

    def report(self, job_id: str, status: str, tag_uid: str | None = None, error: str | None = None):
        body = {"deviceId": self.device_id, "status": status}
        if tag_uid:
            body["tagUid"] = tag_uid
        if error:
            body["error"] = error
        _, answer = self._request("POST", f"/api/v2/nfc/device/jobs/{urllib.request.quote(job_id)}/status", body)
        return answer

    def check_link(self, token: str) -> str:
        """'ok' | 'expired' | 'revoked' | 'unknown' for a token read from a tag."""
        _, answer = self._request("GET", f"/api/v2/nfc/device/links/{urllib.request.quote(token)}")
        return (answer or {}).get("status", "unknown")
