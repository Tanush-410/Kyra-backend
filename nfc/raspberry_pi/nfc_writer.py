"""MODE A, tag issuance: write a session URL to a blank tag as an NDEF URI record, then prove it.

write_url(url) waits for a tag, checks it (NDEF-formatted Type 2, writable, blank, big enough: the capacity
is read from the tag, not assumed), writes the record from the first data page, then reads the whole record
back and compares it with the URL. Success is reported only when the read-back matches, from the same tag.
"""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass

import ndef_handler as ndef

log = logging.getLogger("kyra.nfc.writer")


@dataclass
class WriteResult:
    ok: bool
    error: str | None = None  # no_tag, not_ndef_formatted, read_only, tag_not_blank, insufficient_capacity,
    #                           write_failed, tag_removed, verify_mismatch, read_failed
    uid: str | None = None
    capacity: int | None = None
    used: int | None = None


def _read_area(controller, first: int, count: int):
    pages = []
    for page in range(first, first + count):
        data = controller.read_page(page)
        if data is None:
            return None
        pages.append(data)
    return b"".join(pages)


class NfcWriter:
    def __init__(self, controller, tag_wait_seconds: float = 90):
        self.controller = controller
        self.tag_wait_seconds = tag_wait_seconds

    def wait_for_tag(self, timeout: float | None = None):
        deadline = time.monotonic() + (self.tag_wait_seconds if timeout is None else timeout)
        while time.monotonic() < deadline:
            uid = self.controller.detect(timeout=0.5)
            if uid:
                return uid
        return None

    def write_url(self, url: str, on_step=lambda step: None, timeout: float | None = None) -> WriteResult:
        uid = self.wait_for_tag(timeout)
        if not uid:
            return WriteResult(False, "no_tag")
        uid_hex = uid.hex().upper()
        log.info("tag %s…%s in the field", uid_hex[:4], uid_hex[-2:])  # a partial UID: enough for support

        cc = self.controller.read_page(3)
        if cc is None:
            return WriteResult(False, "read_failed", uid_hex)
        try:
            capacity = ndef.capacity_from_cc(cc)
        except ndef.NdefError:
            return WriteResult(False, "not_ndef_formatted", uid_hex)
        if not ndef.writable_from_cc(cc):
            return WriteResult(False, "read_only", uid_hex, capacity)

        # Blank: no NDEF message yet. A tag that already holds something (someone's Kyra Tag, a bus pass) is
        # never overwritten.
        head = _read_area(self.controller, ndef.FIRST_DATA_PAGE, 4)
        if head is None:
            return WriteResult(False, "read_failed", uid_hex, capacity)
        try:
            existing = ndef.find_ndef(head)
        except ndef.NdefError:
            existing = b"?"  # a message longer than the first 16 bytes: certainly not blank
        if existing:
            return WriteResult(False, "tag_not_blank", uid_hex, capacity)

        tlv = ndef.wrap_tlv(ndef.encode_uri_record(url))
        if len(tlv) > capacity:
            return WriteResult(False, "insufficient_capacity", uid_hex, capacity, len(tlv))

        on_step("writing")
        pages = ndef.to_pages(tlv)
        for offset, data in enumerate(pages):
            if not self.controller.write_page(ndef.FIRST_DATA_PAGE + offset, data):
                still_here = self.controller.detect(timeout=0.2) == uid
                return WriteResult(False, "write_failed" if still_here else "tag_removed", uid_hex, capacity, len(tlv))

        on_step("verifying")
        if self.controller.detect(timeout=0.3) != uid:
            return WriteResult(False, "tag_removed", uid_hex, capacity, len(tlv))
        back = _read_area(self.controller, ndef.FIRST_DATA_PAGE, len(pages))
        if back is None:
            return WriteResult(False, "tag_removed", uid_hex, capacity, len(tlv))
        try:
            written = ndef.decode_uri(ndef.find_ndef(back) or b"")
        except (ndef.NdefError, UnicodeDecodeError):
            written = None
        if written != url:
            return WriteResult(False, "verify_mismatch", uid_hex, capacity, len(tlv))
        log.info("tag programmed and verified (%d of %d bytes)", len(tlv), capacity)
        return WriteResult(True, None, uid_hex, capacity, len(tlv))
