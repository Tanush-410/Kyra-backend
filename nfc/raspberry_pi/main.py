"""The Kyra Tag writer: runs on the Raspberry Pi next to the PN532.

    python3 main.py            # real PN532 (config.py for the settings)
    NFC_MOCK=true python3 main.py   # simulated PN532 and tags, on any computer

MODE A (issue): ask the backend for a tag job, wait for a blank tag, write the session URL, read it back,
report each step (waiting_for_tag, writing, verifying, then succeeded or failed). MODE B (read): when there's
no job, read tags placed on the reader, check the URL is a live Kyra link, and show its Canvas on a connected
display (NFC_DISPLAY_COMMAND). NFC_MODE picks one or both (default both).
"""

from __future__ import annotations

import logging
import shlex
import subprocess
import sys
import time

from backend_client import BackendClient, BackendError
from config import Config
from nfc_reader import NfcReader
from nfc_writer import NfcWriter
from pn532_controller import HardwareError, open_controller

log = logging.getLogger("kyra.nfc")


class JobCancelled(Exception):
    pass


class TagService:
    def __init__(self, config, controller, client, display=None):
        self.config = config
        self.client = client
        self.writer = NfcWriter(controller, config.tag_wait_seconds)
        self.reader = NfcReader(controller, config.allowed_hosts, config.debounce_seconds)
        self.display = display or self._open_on_display
        self.pending = []  # reports the backend didn't get (network down): resent first, in order

    # ---- MODE A: issuance ----
    def _report(self, job_id, status, uid=None, error=None, final=False):
        try:
            self.client.report(job_id, status, tag_uid=uid, error=error)
        except BackendError as problem:
            if problem.status in (404, 409):  # the job was cancelled or timed out on the backend
                if not final:
                    raise JobCancelled() from None
                log.warning("backend no longer wants job %s (%s)", job_id, problem)
                return
            log.warning("report %s for job %s not delivered, will retry: %s", status, job_id, problem)
            self.pending.append((job_id, status, uid, error))

    def flush_reports(self):
        while self.pending:
            job_id, status, uid, error = self.pending[0]
            try:
                self.client.report(job_id, status, tag_uid=uid, error=error)
            except BackendError as problem:
                if problem.status in (404, 409):
                    self.pending.pop(0)
                    continue
                return False
            self.pending.pop(0)
        return True

    def issue(self, job):
        job_id, url = job["jobId"], job["url"]
        log.info("job %s: waiting for a blank tag", job_id)
        try:
            result = self.writer.write_url(url, on_step=lambda step: self._report(job_id, step))
        except JobCancelled:
            log.info("job %s was cancelled; nothing written", job_id)
            return None
        if result.ok:
            self._report(job_id, "succeeded", uid=result.uid, final=True)
        else:
            log.warning("job %s failed: %s", job_id, result.error)
            self._report(job_id, "failed", uid=result.uid, error=result.error, final=True)
        return result

    # ---- MODE B: reading ----
    def _open_on_display(self, url):
        if not self.config.display_command:
            log.info("Kyra Tag read: %s (no display command set)", url.rsplit("/", 1)[0] + "/…")
            return
        # No shell: the validated URL is one argument, so nothing on a tag can run a command.
        args = [part.replace("{url}", url) for part in shlex.split(self.config.display_command)]
        subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    def read_once(self, timeout=0.5):
        event = self.reader.poll(timeout=timeout)
        if not event or not event.valid:
            return event
        try:
            status = self.client.check_link(event.token)
        except BackendError:
            status = "unreachable"  # the page itself says if it has expired
        if status in ("ok", "unreachable"):
            self.display(event.url)
        else:
            log.info("Kyra Tag with a %s link: not shown", status)
        event.reason = None if status in ("ok", "unreachable") else status
        return event

    def run_once(self):
        """One round: deliver pending reports, then a job if there is one, else a tag read."""
        self.flush_reports()
        if self.config.mode in ("both", "issue"):
            try:
                job = self.client.next_job()
            except BackendError as problem:
                log.warning("can't ask the backend for work: %s", problem)
                job = None
            if job:
                return ("issued", self.issue(job))
        if self.config.mode in ("both", "read"):
            return ("read", self.read_once(timeout=min(1.0, self.config.poll_seconds)))
        time.sleep(self.config.poll_seconds)
        return ("idle", None)


def main():
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    config = Config()
    problems = config.check()
    if problems:
        for problem in problems:
            log.error(problem)
        sys.exit(2)
    try:
        controller = open_controller(config)
    except HardwareError as problem:
        log.error("%s", problem)
        sys.exit(3)
    client = BackendClient(config.backend_url, config.device_token, config.device_id)
    service = TagService(config, controller, client)
    log.info("Kyra Tag writer %s running (mode %s, backend %s)", config.device_id, config.mode, config.backend_url)
    try:
        while True:
            kind, _ = service.run_once()
            if kind != "issued":
                time.sleep(0.2 if config.mode in ("both", "read") else 0)
    except KeyboardInterrupt:
        log.info("stopped")


if __name__ == "__main__":
    main()
