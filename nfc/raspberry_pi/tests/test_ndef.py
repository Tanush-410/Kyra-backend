"""NDEF URI records and Type 2 TLVs (ndef_handler.py)."""
import pytest

import ndef_handler as ndef

URL = "https://kyra.style/s/Ab3dE5gH7k"


def test_uri_record_uses_the_https_prefix_code_and_round_trips():
    record = ndef.encode_uri_record(URL)
    # D1 = MB|ME|SR, TNF well-known; type length 1; payload length; "U"; prefix code 0x04 (https://)
    assert record[:4] == bytes([0xD1, 0x01, len(URL) - len("https://") + 1, ord("U")])
    assert record[4] == 0x04
    assert record[5:] == b"kyra.style/s/Ab3dE5gH7k"
    assert ndef.decode_uri(record) == URL
    assert len(record) == 28 and len(ndef.wrap_tlv(record)) == 31, "31 bytes on the tag: an NTAG213 holds 144"


def test_other_prefixes_and_no_prefix():
    assert ndef.encode_uri_record("https://www.kyra.style/x")[4] == 0x02
    assert ndef.encode_uri_record("http://localhost:3000/s/x")[4] == 0x03
    assert ndef.encode_uri_record("kyra:x")[4] == 0x00
    for url in ["https://www.kyra.style/x", "http://localhost:3000/s/x", "kyra:x"]:
        assert ndef.decode_uri(ndef.encode_uri_record(url)) == url


def test_tlv_short_and_long_lengths_and_blank_tags():
    short = ndef.wrap_tlv(b"x" * 10)
    assert short[:2] == bytes([0x03, 10]) and short[-1] == 0xFE
    long = ndef.wrap_tlv(b"x" * 300)
    assert long[:4] == bytes([0x03, 0xFF, 0x01, 0x2C])
    assert ndef.find_ndef(long + bytes(8)) == b"x" * 300
    assert ndef.find_ndef(bytes([0x03, 0x00, 0xFE, 0x00])) is None, "an empty NDEF TLV: a blank tag"
    assert ndef.find_ndef(bytes([0x00, 0x00, 0x03, 0x02, 0xAA, 0xBB])) == b"\xaa\xbb", "NULL TLVs are skipped"
    with pytest.raises(ndef.NdefError):
        ndef.find_ndef(bytes([0x03, 0x20, 0x01]))


def test_capacity_and_write_access_come_from_the_tag():
    assert ndef.capacity_from_cc(bytes([0xE1, 0x10, 0x12, 0x00])) == 144  # NTAG213
    assert ndef.capacity_from_cc(bytes([0xE1, 0x10, 0x3E, 0x00])) == 496  # NTAG215
    assert ndef.writable_from_cc(bytes([0xE1, 0x10, 0x12, 0x00]))
    assert not ndef.writable_from_cc(bytes([0xE1, 0x10, 0x12, 0x0F]))
    with pytest.raises(ndef.NdefError):
        ndef.capacity_from_cc(bytes([0x00, 0x00, 0x00, 0x00]))


def test_pages_are_padded_to_four_bytes():
    assert [len(p) for p in ndef.to_pages(b"123456")] == [4, 4]
    assert ndef.to_pages(b"123456")[1] == b"56\x00\x00"
