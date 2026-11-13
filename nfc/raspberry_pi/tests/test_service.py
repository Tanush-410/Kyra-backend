"""The backend client and the whole writer loop (main.TagService) against a fake KYRA backend over real HTTP,
with the simulated PN532. Covers network failures, cancelled jobs and the complete issuance workflow."""
import json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest

from backend_client import BackendClient, BackendError
from config import Config
from main import TagService
from mock_pn532 import MockPN532, MockTag

TOKEN = "device-secret"
URL = "https://kyra.style/s/Ab3dE5gH7k"


class FakeBackend:
    """Just enough of backend/src/routes/nfc.js: one job, step reports, link checks, injected failures."""

    def __init__(self):
        self.job = {"jobId": "job1", "url": URL, "status": "waiting_for_tag"}
        self.reports = []
        self.fail_next = 0  # answer the next N requests with 503
        self.cancelled = False
        self.auth = []
        backend = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def _send(self, code, body=None):
                raw = json.dumps(body).encode() if body is not None else b""
                self.send_response(code)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)

            def _gate(self):
                backend.auth.append(self.headers.get("Authorization"))
                if self.headers.get("Authorization") != f"Bearer {TOKEN}":
                    self._send(401, {"error": "Device token required."})
                    return False
                if backend.fail_next:
                    backend.fail_next -= 1
                    self._send(503, {"error": "busy"})
                    return False
                return True

            def do_GET(self):
                if not self._gate():
                    return
                if self.path.startswith("/api/v2/nfc/device/next"):
                    return self._send(200, backend.job) if backend.job else self._send(204)
                if self.path.startswith("/api/v2/nfc/device/links/"):
                    return self._send(200, {"status": "ok" if self.path.endswith("Ab3dE5gH7k") else "unknown"})
                self._send(404, {"error": "no route"})

            def do_POST(self):
                if not self._gate():
                    return
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                if backend.cancelled:
                    return self._send(409, {"error": "invalid_transition"})
                backend.reports.append((body["status"], body.get("tagUid"), body.get("error")))
                if body["status"] in ("succeeded", "failed"):
                    backend.job = None
                self._send(200, {"status": body["status"]})

        self.server = HTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self):
        self.server.shutdown()


@pytest.fixture()
def backend():
    fake = FakeBackend()
    yield fake
    fake.close()


def service_for(backend, pn532, **cfg):
    config = Config(backend_url=backend.url, device_token=TOKEN, device_id="pi-test", tag_wait_seconds=0.5, debounce_seconds=3, **cfg)
    client = BackendClient(backend.url, TOKEN, "pi-test", timeout=2, retries=2, backoff=0.01)
    shown = []
    return TagService(config, pn532, client, display=shown.append), shown


def test_the_complete_issuance_workflow(backend):
    pn532 = MockPN532()
    tag = MockTag(bytes.fromhex("04A1B2C3D4E5F6"))
    pn532.place(tag)  # the visitor puts a blank tag on the reader
    service, _ = service_for(backend, pn532)
    kind, result = service.run_once()
    assert kind == "issued" and result.ok
    assert [r[0] for r in backend.reports] == ["writing", "verifying", "succeeded"], "each step, success last"
    assert backend.reports[-1][1] == "04A1B2C3D4E5F6"
    assert all(a == f"Bearer {TOKEN}" for a in backend.auth), "the device token on every request"
    # The tag now opens the Canvas on a phone: it holds exactly the URL.
    from nfc_reader import NfcReader
    assert NfcReader(pn532, ["kyra.style"]).poll().url == URL


def test_a_failed_write_is_reported_as_failed(backend):
    pn532 = MockPN532()
    tag = MockTag(bytes.fromhex("04A1B2C3D4E5F6"))
    tag.corrupt_writes = True
    pn532.place(tag)
    service, _ = service_for(backend, pn532)
    service.run_once()
    assert backend.reports[-1][0] == "failed" and backend.reports[-1][2] == "verify_mismatch"
    assert "succeeded" not in [r[0] for r in backend.reports]


def test_no_tag_in_time_fails_the_job(backend):
    service, _ = service_for(backend, MockPN532())
    service.run_once()
    assert backend.reports == [("failed", None, "no_tag")]


def test_network_failures_are_retried_and_reports_are_not_lost(backend):
    pn532 = MockPN532()
    pn532.place(MockTag(bytes.fromhex("04A1B2C3D4E5F6")))
    service, _ = service_for(backend, pn532)
    backend.fail_next = 2  # the first two requests get 503: the client retries
    service.run_once()
    assert [r[0] for r in backend.reports] == ["writing", "verifying", "succeeded"]

    # The backend goes away entirely after the write: the final report waits and is sent later.
    pn532.remove()
    pn532.place(MockTag(bytes.fromhex("04112233445566")))
    backend.job = {"jobId": "job2", "url": URL, "status": "waiting_for_tag"}
    backend.reports.clear()
    real_report = service.client.report
    calls = {"n": 0}

    def flaky(job_id, status, tag_uid=None, error=None):
        calls["n"] += 1
        if status == "succeeded" and calls["n"] < 5:
            raise BackendError("backend unreachable: connection refused")
        return real_report(job_id, status, tag_uid=tag_uid, error=error)

    service.client.report = flaky
    service.run_once()
    assert [r[0] for r in backend.reports] == ["writing", "verifying"] and len(service.pending) == 1
    service.client.report = real_report
    assert service.flush_reports()
    assert [r[0] for r in backend.reports] == ["writing", "verifying", "succeeded"]


def test_unreachable_backend_raises_after_retries():
    client = BackendClient("http://127.0.0.1:9", TOKEN, "pi", timeout=0.5, retries=1, backoff=0.01)
    with pytest.raises(BackendError):
        client.next_job()


def test_a_job_cancelled_on_the_kiosk_writes_nothing(backend):
    pn532 = MockPN532()
    tag = MockTag(bytes.fromhex("04A1B2C3D4E5F6"))
    pn532.place(tag)
    backend.cancelled = True
    service, _ = service_for(backend, pn532)
    kind, result = service.run_once()
    assert kind == "issued" and result is None
    assert tag.writes == 0, "the visitor said no thanks before the tag was written"


def test_reading_mode_shows_only_live_kyra_links(backend):
    backend.job = None
    pn532 = MockPN532()
    tag = MockTag(bytes.fromhex("04A1B2C3D4E5F6"))
    pn532.place(tag)
    from nfc_writer import NfcWriter
    NfcWriter(pn532).write_url(URL)
    service, shown = service_for(backend, pn532)
    kind, event = service.run_once()
    assert kind == "read" and event.valid and shown == [URL]
    service.run_once()
    assert shown == [URL], "a tag resting on the reader is shown once"
