"""The PN532 NFC reader/writer, wired to the Raspberry Pi by I2C, SPI or UART (config.py: NFC_INTERFACE).

Uses Adafruit's CircuitPython PN532 driver (requirements.txt), imported only here and only when the real
hardware is used, so the rest of the system (and its tests) runs without it. The writer and the reader use
just this interface, which mock_pn532.MockPN532 also provides:

    detect(timeout) -> uid bytes | None     a tag in the field
    read_page(page) -> 4 bytes | None        NFC Forum Type 2 page read (NTAG21x)
    write_page(page, data) -> bool           4-byte page write
"""

from __future__ import annotations

import logging

log = logging.getLogger("kyra.nfc.pn532")


class HardwareError(RuntimeError):
    """The PN532 isn't answering (wiring, interface setting, or the Pi's I2C/SPI/serial not enabled)."""


class PN532Controller:
    def __init__(self, config):
        try:
            import board  # noqa: F401  (Adafruit Blinka)
            import busio
            from digitalio import DigitalInOut
        except ImportError as error:
            raise HardwareError("Adafruit Blinka isn't installed: pip install -r requirements.txt") from error
        try:
            if config.interface == "i2c":
                from adafruit_pn532.i2c import PN532_I2C

                self._pn532 = PN532_I2C(busio.I2C(board.SCL, board.SDA), debug=False)
            elif config.interface == "spi":
                from adafruit_pn532.spi import PN532_SPI

                cs = DigitalInOut(getattr(board, config.spi_cs_pin))
                self._pn532 = PN532_SPI(busio.SPI(board.SCK, board.MOSI, board.MISO), cs, debug=False)
            else:
                import serial
                from adafruit_pn532.uart import PN532_UART

                self._pn532 = PN532_UART(serial.Serial(config.uart_port, baudrate=115200, timeout=0.1), debug=False)
            ic, ver, rev, _support = self._pn532.firmware_version
            self._pn532.SAM_configuration()
            log.info("PN532 ready over %s (firmware %d.%d)", config.interface, ver, rev)
        except HardwareError:
            raise
        except Exception as error:  # the driver raises plain RuntimeErrors for a silent bus
            raise HardwareError(f"PN532 not found over {config.interface}: {error}") from error

    def detect(self, timeout: float = 0.5):
        uid = self._pn532.read_passive_target(timeout=timeout)
        return bytes(uid) if uid else None

    def read_page(self, page: int):
        try:
            data = self._pn532.ntag2xx_read_block(page)
        except Exception:  # a tag pulled away mid-read
            return None
        return bytes(data[:4]) if data else None

    def write_page(self, page: int, data: bytes) -> bool:
        if len(data) != 4:
            raise ValueError("a page is 4 bytes")
        try:
            return bool(self._pn532.ntag2xx_write_block(page, bytes(data)))
        except Exception:
            return False


def open_controller(config):
    """The real PN532, or the simulated one when NFC_MOCK is on."""
    if config.mock:
        from mock_pn532 import MockPN532

        log.warning("NFC_MOCK is on: using the simulated PN532, no real tags are written")
        return MockPN532.demo()
    return PN532Controller(config)
