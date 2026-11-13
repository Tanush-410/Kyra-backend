"""Settings for the Kyra Tag writer, from environment variables (secrets never in code or logs).

KYRA_BACKEND_URL     the KYRA backend, e.g. http://kyra-mirror.local:3000 (add that host to the backend's
                     ALLOWED_HOSTS)
NFC_DEVICE_TOKEN     the device credential; the backend's NFC_DEVICE_TOKEN (not the kiosk's token)
NFC_DEVICE_ID        a name for this writer in logs and jobs (default: the hostname)
NFC_INTERFACE        i2c (default) | spi | uart: how the PN532 is wired
NFC_SPI_CS_PIN       SPI chip-select pin name on the Pi header, e.g. D5 (default D5)
NFC_UART_PORT        serial port for UART (default /dev/serial0)
NFC_MODE             both (default) | issue | read
NFC_ALLOWED_HOSTS    hosts a scanned tag's URL may point to (default kyra.style); others are never opened
NFC_DISPLAY_COMMAND  optional, reading mode: a command to show a scanned Canvas on a connected display, with
                     {url} replaced, e.g. "chromium-browser --kiosk {url}". Empty: the URL is only logged.
NFC_POLL_SECONDS     how often to ask the backend for work (default 2)
NFC_TAG_WAIT_SECONDS how long to wait for a blank tag before giving up on a job (default 90)
NFC_DEBOUNCE_SECONDS reading mode: the same tag is ignored for this long after a read (default 3)
NFC_MOCK             true: the simulated PN532 (mock_pn532.py), for development without the hardware
"""

from __future__ import annotations

import os
import socket
from dataclasses import dataclass, field


def _flag(name: str, default: bool) -> bool:
    raw = os.environ.get(name, "").strip().lower()
    return default if not raw else raw not in ("0", "false", "no", "off")


def _number(name: str, default: float) -> float:
    try:
        return float(os.environ.get(name, "") or default)
    except ValueError:
        return default


@dataclass
class Config:
    backend_url: str = field(default_factory=lambda: os.environ.get("KYRA_BACKEND_URL", "http://localhost:3000").rstrip("/"))
    device_token: str = field(default_factory=lambda: os.environ.get("NFC_DEVICE_TOKEN", ""))
    device_id: str = field(default_factory=lambda: os.environ.get("NFC_DEVICE_ID", socket.gethostname()[:40] or "kyra-tag-writer"))
    interface: str = field(default_factory=lambda: os.environ.get("NFC_INTERFACE", "i2c").strip().lower())
    spi_cs_pin: str = field(default_factory=lambda: os.environ.get("NFC_SPI_CS_PIN", "D5"))
    uart_port: str = field(default_factory=lambda: os.environ.get("NFC_UART_PORT", "/dev/serial0"))
    mode: str = field(default_factory=lambda: os.environ.get("NFC_MODE", "both").strip().lower())
    allowed_hosts: tuple = field(default_factory=lambda: tuple(h.strip().lower() for h in os.environ.get("NFC_ALLOWED_HOSTS", "kyra.style").split(",") if h.strip()))
    display_command: str = field(default_factory=lambda: os.environ.get("NFC_DISPLAY_COMMAND", ""))
    poll_seconds: float = field(default_factory=lambda: _number("NFC_POLL_SECONDS", 2))
    tag_wait_seconds: float = field(default_factory=lambda: _number("NFC_TAG_WAIT_SECONDS", 90))
    debounce_seconds: float = field(default_factory=lambda: _number("NFC_DEBOUNCE_SECONDS", 3))
    mock: bool = field(default_factory=lambda: _flag("NFC_MOCK", False))

    def check(self) -> list[str]:
        problems = []
        if self.interface not in ("i2c", "spi", "uart"):
            problems.append(f"NFC_INTERFACE must be i2c, spi or uart (not {self.interface!r})")
        if self.mode not in ("both", "issue", "read"):
            problems.append(f"NFC_MODE must be both, issue or read (not {self.mode!r})")
        if self.mode in ("both", "issue") and not self.device_token:
            problems.append("NFC_DEVICE_TOKEN is empty: the backend will refuse this device")
        if not self.backend_url.startswith(("http://", "https://")):
            problems.append("KYRA_BACKEND_URL must start with http:// or https://")
        return problems
