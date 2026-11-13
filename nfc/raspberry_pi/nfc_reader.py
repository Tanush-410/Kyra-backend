"""MODE B, tag reading: a programmed Kyra Tag placed on the PN532 is read, its URL checked, and (if the
installation has a display) its Canvas shown.

Only https URLs on an allowed Kyra host, in the /s/<token> form, are ever accepted: anything else on a tag
is reported as foreign and never opened. The same tag is read once per placement (debounce): it stays
ignored while it rests on the reader and for NFC_DEBOUNCE_SECONDS after.

(Phones don't need any of this: an NFC phone reads the URL from the tag itself and opens its browser.)
"""

from __future__ import annotations

import logging
import re
import time
from dataclasses import dataclass
from urllib.parse import urlsplit

import ndef_handler as ndef

log = logging.getLogger("kyra.nfc.reader")
TOKEN = re.compile(r"^/s/([A-HJ-NP-Za-km-z2-9]{8,32})$")


@dataclass
class ReadEvent:
    uid: str
    url: str | None
    valid: bool
    reason: str | None = None  # empty, not_ndef, foreign_url, not_https, malformed
    token: str | None = None


def check_url(url: str, allowed_hosts) -> tuple[bool, str | None, str | None]:
    """(valid, reason, token) for a URL read from a tag."""
    try:
        parts = urlsplit(url)
    except ValueError:
        return False, "malformed", None
    host = (parts.hostname or "").lower()
    # https only; plain http just for a backend on this machine (development, NFC_ALLOWED_HOSTS=localhost).
    if parts.scheme != "https" and not (parts.scheme == "http" and host in ("localhost", "127.0.0.1")):
        return False, "not_https", None
    if host not in allowed_hosts or parts.username or parts.password or (parts.scheme == "https" and parts.port not in (None, 443)):
        return False, "foreign_url", None
    match = TOKEN.match(parts.path)
    if not match or parts.query or parts.fragment:
        return False, "malformed", None
    return True, None, match.group(1)


class NfcReader:
    def __init__(self, controller, allowed_hosts, debounce_seconds: float = 3, clock=time.monotonic):
        self.controller = controller
        self.allowed_hosts = tuple(h.lower() for h in allowed_hosts)
        self.debounce_seconds = debounce_seconds
        self.clock = clock
        self._last_uid = None
        self._last_seen = 0.0

    def poll(self, timeout: float = 0.5):
        """A ReadEvent for a newly placed tag, or None (no tag, or the same tag again within the debounce)."""
        uid = self.controller.detect(timeout=timeout)
        now = self.clock()
        if not uid:
            return None
        if uid == self._last_uid and now - self._last_seen < self.debounce_seconds:
            self._last_seen = now  # still resting on the reader
            return None
        self._last_uid, self._last_seen = uid, now
        uid_hex = uid.hex().upper()
        cc = self.controller.read_page(3)
        try:
            capacity = ndef.capacity_from_cc(cc or b"")
        except ndef.NdefError:
            return ReadEvent(uid_hex, None, False, "not_ndef")
        data = b""
        for page in range(ndef.FIRST_DATA_PAGE, ndef.FIRST_DATA_PAGE + capacity // 4):
            chunk = self.controller.read_page(page)
            if chunk is None:
                break
            data += chunk
            try:
                if ndef.find_ndef(data) is not None or (data and data[0] == ndef.TLV_TERMINATOR):
                    break
            except ndef.NdefError:
                continue  # the record runs on into the next pages
        try:
            message = ndef.find_ndef(data)
            url = ndef.decode_uri(message) if message else None
        except (ndef.NdefError, UnicodeDecodeError):
            return ReadEvent(uid_hex, None, False, "malformed")
        if not url:
            return ReadEvent(uid_hex, None, False, "empty")
        valid, reason, token = check_url(url, self.allowed_hosts)
        if not valid:
            log.warning("tag with a %s URL ignored", reason)
            return ReadEvent(uid_hex, None, False, reason)
        return ReadEvent(uid_hex, url, True, None, token)
