"""NDEF encoding for Kyra Tags: one URI record in an NDEF message, in the TLV block of an NFC Forum Type 2
tag (NTAG213/215/216 and similar), the kind a PN532 writes and every NFC phone reads.

The URL is stored as an NDEF URI record (NFC Forum URI RTD), not as text: the phone opens it in the browser.
The "https://" prefix is stored as one code byte, so https://kyra.style/s/<10 characters> needs 24 bytes of
record (28 with its TLV wrapping), well inside an NTAG213's 144-byte data area.
"""

from __future__ import annotations

# NFC Forum URI Record Type Definition, table 3: prefix codes (longest first when encoding).
URI_PREFIXES = [
    "", "http://www.", "https://www.", "http://", "https://", "tel:", "mailto:", "ftp://anonymous:anonymous@",
    "ftp://ftp.", "ftps://", "sftp://", "smb://", "nfs://", "ftp://", "dav://", "news:", "telnet://", "imap:",
    "rtsp://", "urn:", "pop:", "sip:", "sips:", "tftp:", "btspp://", "btl2cap://", "btgoep://", "tcpobex://",
    "irdaobex://", "file://", "urn:epc:id:", "urn:epc:tag:", "urn:epc:pat:", "urn:epc:raw:", "urn:epc:", "urn:nfc:",
]

TLV_NDEF = 0x03
TLV_TERMINATOR = 0xFE
TLV_NULL = 0x00
CC_MAGIC = 0xE1
FIRST_DATA_PAGE = 4  # Type 2 tags: pages 0-2 UID and locks, page 3 the capability container


class NdefError(ValueError):
    """The bytes aren't a valid NDEF message (or not the one we expected)."""


def encode_uri_record(url: str) -> bytes:
    """An NDEF message with one URI record holding url."""
    if not isinstance(url, str) or not url:
        raise NdefError("empty URL")
    code, rest = 0, url
    for i, prefix in sorted(enumerate(URI_PREFIXES), key=lambda p: -len(p[1])):
        if prefix and url.startswith(prefix):
            code, rest = i, url[len(prefix):]
            break
    payload = bytes([code]) + rest.encode("utf-8")
    if len(payload) > 255:
        raise NdefError("URL too long for a short record")
    # MB=1 ME=1 CF=0 SR=1 IL=0 TNF=1 (well-known) -> 0xD1; type "U"
    return bytes([0xD1, 0x01, len(payload)]) + b"U" + payload


def decode_records(message: bytes) -> list[tuple[int, bytes, bytes]]:
    """[(tnf, type, payload)] for each record of an NDEF message."""
    records, i = [], 0
    while i < len(message):
        header = message[i]
        tnf, short, has_id = header & 0x07, bool(header & 0x10), bool(header & 0x08)
        if i + 2 > len(message):
            raise NdefError("truncated record header")
        type_len = message[i + 1]
        j = i + 2
        if short:
            payload_len = message[j]
            j += 1
        else:
            if j + 4 > len(message):
                raise NdefError("truncated record length")
            payload_len = int.from_bytes(message[j:j + 4], "big")
            j += 4
        id_len = 0
        if has_id:
            id_len = message[j]
            j += 1
        rtype = message[j:j + type_len]
        j += type_len + id_len
        payload = message[j:j + payload_len]
        if len(payload) != payload_len:
            raise NdefError("truncated record payload")
        records.append((tnf, bytes(rtype), bytes(payload)))
        j += payload_len
        i = j
        if header & 0x40:  # ME: the last record
            break
    return records


def decode_uri(message: bytes) -> str | None:
    """The first URI record's URL, or None."""
    for tnf, rtype, payload in decode_records(message):
        if tnf == 0x01 and rtype == b"U" and payload:
            code = payload[0]
            prefix = URI_PREFIXES[code] if code < len(URI_PREFIXES) else ""
            return prefix + payload[1:].decode("utf-8", errors="strict")
    return None


def wrap_tlv(message: bytes) -> bytes:
    """The NDEF message TLV, then the terminator TLV, as written from the first data page."""
    n = len(message)
    length = bytes([n]) if n < 0xFF else bytes([0xFF]) + n.to_bytes(2, "big")
    return bytes([TLV_NDEF]) + length + message + bytes([TLV_TERMINATOR])


def find_ndef(data: bytes) -> bytes | None:
    """The NDEF message in a Type 2 tag's data area, or None (no NDEF TLV, or an empty one: a blank tag)."""
    i = 0
    while i < len(data):
        t = data[i]
        if t == TLV_NULL:
            i += 1
            continue
        if t == TLV_TERMINATOR:
            return None
        if i + 1 >= len(data):
            return None
        n, head = data[i + 1], 2
        if n == 0xFF:
            if i + 3 >= len(data):
                return None
            n, head = int.from_bytes(data[i + 2:i + 4], "big"), 4
        if t == TLV_NDEF:
            value = data[i + head:i + head + n]
            if len(value) != n:
                raise NdefError("NDEF TLV runs past the data read")
            return bytes(value) or None
        i += head + n
    return None


def capacity_from_cc(cc: bytes) -> int:
    """Data-area size in bytes from the capability container (page 3), e.g. NTAG213: 0x12 * 8 = 144."""
    if len(cc) < 4 or cc[0] != CC_MAGIC:
        raise NdefError("not an NDEF-formatted Type 2 tag")
    return cc[2] * 8


def writable_from_cc(cc: bytes) -> bool:
    """Write access nibble 0x0: writable; 0xF: read-only (locked)."""
    return (cc[3] & 0x0F) == 0x00


def to_pages(data: bytes) -> list[bytes]:
    """Split into 4-byte pages, the last padded with zeros."""
    padded = data + bytes((-len(data)) % 4)
    return [padded[i:i + 4] for i in range(0, len(padded), 4)]
