"""Writing and reading Kyra Tags on the simulated PN532 (mock_pn532.py). No real hardware is involved."""
from mock_pn532 import MockPN532, MockTag
from nfc_reader import NfcReader, check_url
from nfc_writer import NfcWriter

URL = "https://kyra.style/s/Ab3dE5gH7k"
UID = bytes.fromhex("04A1B2C3D4E5F6")


def setup(tag=None):
    pn532 = MockPN532()
    if tag is not None:
        pn532.place(tag)
    return pn532, NfcWriter(pn532, tag_wait_seconds=0.3)


def test_a_blank_tag_is_written_and_verified_by_reading_it_back():
    tag = MockTag(UID)
    pn532, writer = setup(tag)
    steps = []
    result = writer.write_url(URL, on_step=steps.append)
    assert result.ok and result.error is None
    assert steps == ["writing", "verifying"]
    assert result.uid == "04A1B2C3D4E5F6" and result.capacity == 144 and result.used == 31
    # A phone reads the same memory: the URL is really there as an NDEF URI record.
    reader = NfcReader(pn532, ["kyra.style"])
    event = reader.poll()
    assert event.valid and event.url == URL and event.token == "Ab3dE5gH7k"


def test_no_tag_read_only_not_blank_and_too_small_are_refused_before_writing():
    assert setup()[1].write_url(URL).error == "no_tag"
    assert setup(MockTag(UID, read_only=True))[1].write_url(URL).error == "read_only"
    used = MockTag(UID)
    pn532, writer = setup(used)
    assert writer.write_url(URL).ok
    assert writer.write_url("https://kyra.style/s/OtherOther").error == "tag_not_blank", "someone's tag is never overwritten"
    tiny = MockTag(UID, size_code=0x03)  # 24 bytes: too small for 31
    result = setup(tiny)[1].write_url(URL)
    assert (result.error, result.capacity, result.used) == ("insufficient_capacity", 24, 31)
    assert tiny.writes == 0
    unformatted = MockTag(UID)
    unformatted.pages[3][:] = bytes(4)
    assert setup(unformatted)[1].write_url(URL).error == "not_ndef_formatted"


def test_failed_interrupted_and_corrupted_writes_are_reported_not_claimed():
    failing = MockTag(UID)
    failing.fail_write_at = 6
    assert setup(failing)[1].write_url(URL).error == "write_failed"

    pulled = MockTag(UID)
    pulled.remove_after_writes = 2
    pn532, writer = setup(pulled)
    assert writer.write_url(URL).error == "tag_removed"

    corrupt = MockTag(UID)
    corrupt.corrupt_writes = True
    assert setup(corrupt)[1].write_url(URL).error == "verify_mismatch", "the read-back catches a bad write"


def test_reading_validates_the_domain_and_ignores_repeat_scans():
    assert check_url(URL, ["kyra.style"])[0]
    assert check_url("https://evil.example/s/Ab3dE5gH7k", ["kyra.style"])[1] == "foreign_url"
    assert check_url("https://kyra.style.evil.example/s/Ab3dE5gH7k", ["kyra.style"])[1] == "foreign_url"
    assert check_url("https://user@kyra.style/s/Ab3dE5gH7k", ["kyra.style"])[1] == "foreign_url"
    assert check_url("http://kyra.style/s/Ab3dE5gH7k", ["kyra.style"])[1] == "not_https"
    assert check_url("https://kyra.style/admin", ["kyra.style"])[1] == "malformed"
    assert check_url("https://kyra.style/s/Ab3dE5gH7k?next=evil", ["kyra.style"])[1] == "malformed"
    assert check_url("http://localhost/s/Ab3dE5gH7k", ["localhost"])[0], "development: a backend on this machine"

    tag = MockTag(UID)
    pn532, writer = setup(tag)
    writer.write_url(URL)
    now = [100.0]
    reader = NfcReader(pn532, ["kyra.style"], debounce_seconds=3, clock=lambda: now[0])
    assert reader.poll().valid
    now[0] += 1
    assert reader.poll() is None, "the same tag still on the reader"
    now[0] += 10
    pn532.remove()
    assert reader.poll() is None
    pn532.place(tag)
    assert reader.poll().valid, "placed again later: read again"
    other = MockTag(bytes.fromhex("04FFEEDDCCBBAA"))
    setup(other)[1]  # blank
    pn532.place(other)
    assert reader.poll().reason == "empty", "a different tag is read straight away"


def test_a_foreign_tag_is_never_reported_as_valid():
    foreign = MockTag(UID)
    pn532, writer = setup(foreign)
    writer.write_url("https://evil.example/s/Ab3dE5gH7k")
    event = NfcReader(pn532, ["kyra.style"]).poll()
    assert not event.valid and event.reason == "foreign_url" and event.url is None
