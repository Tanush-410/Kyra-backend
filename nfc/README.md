# KYRA AI NFC Tags

A visitor who finishes a session can take home a **Kyra Tag**: a small NFC tag holding a short link
(`https://kyra.style/s/{token}`) to their **Kyra Canvas** (the visit's results page). Tapping the tag with
a phone opens the link. The tag holds only the URL, never the Canvas itself.

```
 kiosk (Kyra-UI-V1)          backend (Fastify)                 Raspberry Pi + PN532
 "Would you like a     ──►   POST …/nfc/issue: a tag job  ◄──  GET  /device/next     (polls, device token)
  Kyra Tag?"  YES             with the visit's short link       wait for a blank tag, write NDEF URI,
 shows each step       ◄──   job status (kiosk polls)     ◄──  POST /device/jobs/:id/status
                                                                 writing → verifying → succeeded | failed
 phone taps the tag   ──►   GET /s/{token}  → the Canvas
```

Everything for this feature lives in its own files, so it's easy to find and to tell apart from the
rest of KYRA:

| Where | What |
|---|---|
| `backend/src/lib/nfc-links.js` | Short links: random tokens, link ↔ session ↔ Canvas, expiry, revocation |
| `backend/src/lib/nfc-jobs.js` | Tag jobs and their state machine; the tag log (`tags.jsonl`) |
| `backend/src/routes/nfc.js` | The kiosk, device and operator API, and the public `/s/{token}` page |
| `backend/test/nfc.test.js`, `nfc-e2e.test.js` | Backend tests; the cross-process test with the real `main.py` |
| `Kyra-UI-V1/src/api/nfcClient.js` | The kiosk's calls, and the visitor-facing status text |
| `Kyra-UI-V1/src/screens/nfc/KyraTagScreen.jsx/.css` | "Would you like a Kyra Tag?" and its states |
| `Kyra-UI-V1/src/lib/nfcRoutes.js` | The screen's route (`/kyra-tag`) |
| `nfc/raspberry_pi/` | The tag writer (Python), its mock hardware and tests |

The kiosk edits outside those files are small. "I'm done" (on the look, Rate and changes, and checkout)
now goes to `/kyra-tag` instead of `/bye`. `App.jsx` gets the route, `StillHereGuard` pauses its idle
countdown on that screen, and `ComponentPreview` gets the `/dev/tag-*` previews. Exit and the bin still go
straight to Bye, because those tell the visitor their photo and looks will be forgotten.

## 1. How it works

### Short links (phase 1)
- **Token:** each finished visit gets one link token, 10 characters (`NFC_TOKEN_LENGTH`, 8–32). The
  alphabet has no look-alike characters (no `0 O 1 l I`), and characters come from `crypto.randomBytes`
  with rejection sampling, about 58 bits at 10 characters. Tokens are never sequential or derived from the
  session.
- **Storage:** the mapping is stored as `RUNTIME_DIR/nfc/links/{token}.json`, which holds
  `{ token, sessionId, resultsToken, createdAt, expiresAt, revokedAt }`. The backend has no database; this
  follows the same file pattern as the results pages.
- **`GET /s/{token}`** renders the visit's Canvas (the same page as the profile screen's QR). Problem cases
  get a styled page and a proper status code:
  - malformed or unknown token: **404**
  - expired or revoked: **410**
  - Canvas files already deleted: **410**
- **Expiry:** a link made for a tag keeps its Canvas for `NFC_KEEP_HOURS` (default 720 h, 30 days)
  instead of the usual `KEEP_HOURS`. The sweep deletes the link a week after it expires.
- **Revoking:** `DELETE /api/v2/nfc/links/{token}` needs the operator token. Use it if a visitor asks for
  their tag to stop working.

### Tag issuance (phases 2 and 4)
1. **Prompt:** "I'm done" opens **Would you like a Kyra Tag?**, but only when the backend has
   `NFC_TAGS=true` **and** a tag writer polled in the last 30 s (`GET /api/v2/nfc/status`). Otherwise the
   kiosk goes straight to Bye, as before.
2. **NO** shows the same short link as a QR code, so the Canvas is still reachable.
3. **YES** calls `POST /api/v2/sessions/{id}/nfc/issue`, which creates a job holding the URL. The kiosk
   polls `GET /api/v2/nfc/jobs/{jobId}` and shows:
   - Preparing your Kyra Tag (`queued`)
   - Waiting for a blank NFC tag (`waiting_for_tag`)
   - Writing your personalised URL (`writing`, `verifying`)
   - Tag successfully programmed (`succeeded`)
   - Programming failed (`failed`): the reason in plain words, then **Try again**, **Show a QR code
     instead** or **I'm done**
4. **The Pi:** it takes the job (`GET /api/v2/nfc/device/next`) and reports each step. The backend
   accepts only `writing → verifying → succeeded` from the device that claimed the job. "Succeeded"
   without "verifying" is refused, and the Pi reports "verifying" only after it has written the tag. The
   Pi reports `succeeded` only after reading the tag back and getting the same URL from the same tag
   UID.
5. **Leaving early:** if the visitor leaves the screen before placing a tag, the job is cancelled, so
   nothing is written later. A job left unclaimed or stuck fails after `NFC_JOB_TIMEOUT_S` (180 s).
6. **Tag log:** each programmed tag is appended to `RUNTIME_DIR/nfc/tags.jsonl` (job, link token, tag
   UID, time).

### The tag writer (phase 3, `nfc/raspberry_pi/`)
| File | Role |
|---|---|
| `main.py` | The loop: deliver unsent reports, take a job (MODE A), else read tags (MODE B) |
| `pn532_controller.py` | The real PN532 over I2C, SPI or UART (Adafruit CircuitPython driver) |
| `mock_pn532.py` | A byte-accurate simulated PN532 and NTAG213/215/216, with fault switches |
| `nfc_writer.py` | MODE A: checks the tag, writes, reads back, verifies |
| `nfc_reader.py` | MODE B: reads a tag, validates the URL, debounces repeat scans |
| `ndef_handler.py` | NDEF URI records and Type 2 TLVs (encode and decode), capacity from the tag |
| `backend_client.py` | The device API, with retries and backoff for network errors and 5xx |
| `config.py` | Settings from environment variables |

**MODE A, writing.** Before writing anything, the writer checks the tag in this order:
1. **Formatted:** the tag is NDEF-formatted (capability container `E1` on page 3).
2. **Writable:** the access bits say it isn't read-only.
3. **Blank:** its NDEF message is empty. A tag that already holds something is **never overwritten**,
   whether it's someone else's Kyra Tag or a bus pass.
4. **Capacity:** it's big enough, using the capacity read from the tag rather than an assumed size.

If the checks pass, it writes one URI record from page 4. A `kyra.style/s/…` link takes 31 bytes; the
smallest common tag, NTAG213, holds 144.

Possible failure codes:

| Code | Meaning |
|---|---|
| `no_tag` | No tag was placed in time |
| `not_ndef_formatted` | The tag isn't NDEF-formatted |
| `read_only` | The tag is locked |
| `tag_not_blank` | The tag already holds something |
| `insufficient_capacity` | The tag is too small for the link |
| `write_failed` | A write failed |
| `tag_removed` | The tag left the reader too soon |
| `verify_mismatch` | The read-back didn't match the URL |
| `read_failed` | The tag couldn't be read |

Logs show a partial tag UID and never the token or full URL.

**MODE B, reading.** When there's no job, the Pi reads tags placed on its reader. A URL is **opened only
if all of these hold**:
- it's `https` (`http` is allowed only for localhost);
- its host is in `NFC_ALLOWED_HOSTS` exactly (`kyra.style.evil.com` fails);
- it has no user info and no unusual port;
- its path is exactly `/s/{token}` with nothing after it;
- the backend says the link is live.

The display command runs without a shell, with the URL as one argument. The same tag left on the reader
is read once, and repeat scans within `NFC_DEBOUNCE_SECONDS` are ignored.

Phones don't need the Pi at all: a phone reads the URL from the tag itself and opens its browser.

## 2. Hardware and wiring

**Parts:**
- a Raspberry Pi 3, 4 or 5 (or a Zero 2 W) running Raspberry Pi OS;
- a PN532 board (Adafruit PN532 breakout or HAT, or an Elechouse PN532 V3 module);
- blank **NTAG213, NTAG215 or NTAG216** tags, NFC Forum Type 2. NTAG213 is plenty. Buy them
  **NDEF-formatted** (most are); MIFARE Classic tags aren't supported.

**Set the PN532's interface switches** to match `NFC_INTERFACE`:

| Interface | Adafruit (SEL0 / SEL1) | Elechouse V3 (switch 1 / 2) |
|---|---|---|
| I2C | ON / OFF | ON / OFF |
| SPI | OFF / ON | OFF / ON |
| UART | OFF / OFF | OFF / OFF |

Power the PN532 from the Pi's **3.3 V** (pin 1) and GND (pin 6) in every mode.

| PN532 | I2C (`NFC_INTERFACE=i2c`) | SPI (`spi`) | UART (`uart`) |
|---|---|---|---|
| SDA / MOSI / TX | GPIO2 SDA, pin 3 | MOSI: GPIO10, pin 19 | TX → GPIO15 RXD, pin 10 |
| SCL / SCK / RX | GPIO3 SCL, pin 5 | SCK: GPIO11, pin 23 | RX → GPIO14 TXD, pin 8 |
| MISO | – | GPIO9, pin 21 | – |
| SS / CS | – | GPIO5, pin 29 (`NFC_SPI_CS_PIN=D5`) | – |

**Turn on the bus you use** with `sudo raspi-config`, then Interface Options:
- **I2C:** enable I2C.
- **SPI:** enable SPI.
- **UART:** under Serial Port, say no to the login shell and yes to the serial hardware.

Then reboot. On I2C, `i2cdetect -y 1` should show the PN532 at **0x24**. If I2C is unreliable on your Pi
(the PN532 stretches the clock), use SPI or UART instead.

## 3. Install and run on the Pi

```bash
sudo useradd -r -m -G i2c,spi,gpio,dialout kyra        # a service user with bus access
sudo mkdir -p /opt/kyra && sudo chown kyra /opt/kyra
sudo -u kyra git clone https://github.com/Tanush-410/Kyra-backend /opt/kyra   # or copy nfc/ only
cd /opt/kyra/nfc/raspberry_pi
sudo -u kyra python3 -m venv .venv
sudo -u kyra .venv/bin/pip install -r requirements.txt

sudo cp kyra-nfc.env.example /etc/kyra-nfc.env
sudo chmod 600 /etc/kyra-nfc.env && sudo nano /etc/kyra-nfc.env   # KYRA_BACKEND_URL, NFC_DEVICE_TOKEN

# Try it in the foreground first:
sudo -u kyra env $(sudo cat /etc/kyra-nfc.env | grep -v '^#' | xargs) .venv/bin/python main.py
```

On start it logs `PN532 ready over i2c (firmware 1.6)`. If the PN532 isn't answering it exits with
`PN532 not found over …`. In that case check the switches, the wiring and that the bus is enabled.

**Run it as a service** (it restarts by itself and starts at boot):

```bash
sudo cp kyra-nfc.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now kyra-nfc
journalctl -u kyra-nfc -f
```

**Without the hardware** (any computer), set `NFC_MOCK=true`. A simulated blank NTAG213 is "placed" 2 s
after start:

```bash
cd nfc/raspberry_pi
NFC_MOCK=true KYRA_BACKEND_URL=http://localhost:3000 NFC_DEVICE_TOKEN=… python3 main.py
```

## 4. Backend settings (`backend/.env`)

```
NFC_TAGS=true                          # offer Kyra Tags (off by default)
NFC_DEVICE_TOKEN=<long random value>   # the Pi's credential: openssl rand -hex 32
NFC_PUBLIC_BASE_URL=https://kyra.style # what goes on the tag
NFC_TOKEN_LENGTH=10
NFC_KEEP_HOURS=720                     # how long a tag's Canvas stays up
NFC_JOB_TIMEOUT_S=180
```

Add the Pi's address for the backend (e.g. `kyra-mirror.local`) to `ALLOWED_HOSTS` if the Pi uses a host
name. Restart the backend after changing these.

**Going live at kyra.style.** Tags in the wild must point to an address phones can reach, so
`https://kyra.style/s/*` has to reach this backend's `/s/:token` over HTTPS. Two ways to do that:
- **A reverse proxy** (Caddy, nginx, Cloudflare Tunnel) in front of the mirror's backend that forwards only
  `/s/*` and `/results/*`. The kiosk and device APIs need tokens, but shouldn't be exposed anyway.
- **A small public service** holding the Canvas pages, with this backend uploading them.

This repo does the first part: the links, the pages, and all their states. Choose and set up the hosting
before handing out tags. Tags written with a `localhost` or LAN address only work on that network.

## 5. Tests

```bash
cd backend && npm test                                 # includes nfc.test.js and nfc-e2e.test.js
cd nfc/raspberry_pi && python3 -m pytest tests -q      # needs pytest
```

| Suite | Covers |
|---|---|
| `nfc/raspberry_pi/tests` (17) | NDEF encoding: prefixes, long TLVs, capacity. Writing on mock hardware: success with read-back, and refusals for no tag, read-only, not blank, too small or unformatted. Failed, interrupted and corrupted writes. Reading: domain checks, debounce, a different tag. The backend client and the whole loop against a fake HTTP backend: retries on 503, reports kept while the backend is down, cancelled jobs, reading mode. |
| `backend/test/nfc.test.js` (5) | Token randomness and format. Link → Canvas, and the unknown, invalid, expired (410) and revoked cases. The job lifecycle with device auth. Success refused without verifying; another device refused. The 30-day keep. Failed, cancelled and disabled cases; timeouts. |
| `backend/test/nfc-e2e.test.js` (1) | A visit, then the real `main.py` (`NFC_MOCK`) against the backend over HTTP, then YES. The job goes to succeeded after the read-back, the `/s/` link opens the Canvas, and the Pi in reading mode recognises the tag. |

**Not tested yet: real hardware.** All of the above runs on the simulated PN532. Before an event:
1. With the real Pi and PN532, issue a tag from the kiosk.
2. Tap it with an iPhone and an Android phone.
3. Try a non-blank tag (it must be refused) and lift a tag mid-write (it must fail, not succeed).

The kiosk screens can be previewed at `/dev/tag-ask`, `tag-waiting`, `tag-writing`, `tag-done`,
`tag-failed` and `tag-link` (`npm run dev`).

## 6. Security notes

- **Bearer links:** the short link works for anyone who has it. Treat it like the results QR: hard to
  guess, temporary, and revocable by staff.
- **Device API:** `/api/v2/nfc/device/*` accepts only `NFC_DEVICE_TOKEN`, compared in constant time.
  The kiosk token doesn't work there. The kiosk never sees the device token, and the device token can't
  call the kiosk API.
- **Secrets:** they live only in `backend/.env` and `/etc/kyra-nfc.env` (mode 600), never in git or the
  frontend.
- **Reading mode:** the Pi opens only validated Kyra links (see MODE B). Nothing read from a tag reaches a
  shell.
- **Tags in public:** tags are left writable so they work on every phone. A writable tag could be
  rewritten by someone with an NFC app. If that matters for an event, lock the tags after writing (a
  one-way step, not done by this code).
