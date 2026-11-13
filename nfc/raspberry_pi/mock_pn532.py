"""A simulated PN532 with simulated NTAG tags, so the whole Kyra Tag system runs and is tested without a
Raspberry Pi or a PN532. It behaves like pn532_controller.PN532Controller (detect, read_page, write_page)
over a byte-accurate NFC Forum Type 2 memory map:

    pages 0-2   UID and lock bytes
    page 3      capability container E1 10 <size/8> <access>   (NTAG213: E1 10 12 00 -> 144 data bytes)
    pages 4..   the data area (a blank tag starts with an empty NDEF TLV: 03 00 FE 00)

Faults can be switched on per tag to test failure handling: a write failing at a page, the tag being pulled
away mid-write, corrupted writes, read-only tags. Nothing here touches real hardware.
"""

from __future__ import annotations

import threading
import time

SIZES = {"NTAG213": 0x12, "NTAG215": 0x3E, "NTAG216": 0x6D}


class MockTag:
    def __init__(self, uid: bytes, kind: str = "NTAG213", size_code: int | None = None, read_only: bool = False, blank: bool = True):
        self.uid = bytes(uid)
        size = size_code if size_code is not None else SIZES[kind]
        self.pages = [bytearray(4) for _ in range(4 + size * 2)]
        self.pages[0][:3] = self.uid[:3]
        self.pages[1][:] = self.uid[3:7].ljust(4, b"\x00")
        self.pages[3][:] = bytes([0xE1, 0x10, size, 0x0F if read_only else 0x00])
        if blank:
            self.pages[4][:] = bytes([0x03, 0x00, 0xFE, 0x00])
        self.fail_write_at = None  # page number: that write returns failure
        self.remove_after_writes = None  # writes before the tag "leaves the field"
        self.corrupt_writes = False  # writes land with one byte flipped
        self.writes = 0

    def data(self) -> bytes:
        return b"".join(bytes(p) for p in self.pages[4:])


class MockPN532:
    def __init__(self):
        self._tag = None
        self._lock = threading.Lock()
        self.auto_tags = []  # (delay_seconds, MockTag): placed when detect() is first called after the delay
        self._started = None

    @classmethod
    def demo(cls):
        """For NFC_MOCK runs: a blank NTAG213 is 'placed' 2 seconds after the writer starts waiting."""
        mock = cls()
        mock.auto_tags.append((2.0, MockTag(bytes.fromhex("04A1B2C3D4E5F6"))))
        return mock

    def place(self, tag: MockTag):
        with self._lock:
            self._tag = tag

    def remove(self):
        with self._lock:
            self._tag = None

    @property
    def tag(self):
        return self._tag

    def detect(self, timeout: float = 0.5):
        if self._started is None:
            self._started = time.monotonic()
        if self._tag is None and self.auto_tags:
            delay, tag = self.auto_tags[0]
            if time.monotonic() - self._started >= delay:
                self.auto_tags.pop(0)
                self.place(tag)
        with self._lock:
            if self._tag is not None:
                return self._tag.uid
        time.sleep(min(timeout, 0.05))
        return None

    def read_page(self, page: int):
        with self._lock:
            tag = self._tag
            if tag is None or page >= len(tag.pages):
                return None
            return bytes(tag.pages[page])

    def write_page(self, page: int, data: bytes) -> bool:
        if len(data) != 4:
            raise ValueError("a page is 4 bytes")
        with self._lock:
            tag = self._tag
            if tag is None or page < 4 or page >= len(tag.pages):
                return False
            if tag.pages[3][3] & 0x0F:  # read-only
                return False
            if tag.remove_after_writes is not None and tag.writes >= tag.remove_after_writes:
                self._tag = None
                return False
            if tag.fail_write_at == page:
                return False
            value = bytearray(data)
            if tag.corrupt_writes:
                value[-1] ^= 0x5A
            tag.pages[page][:] = value
            tag.writes += 1
            return True
