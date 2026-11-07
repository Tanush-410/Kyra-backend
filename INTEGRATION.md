# Integrating this repo with the existing KYRA frontend and backend

This repo holds the KYRA mirror backend and the camera sidecar. This guide is for the engineers who connect
it to the team's mirror frontend (the Tauri app) and to the backend the team built before. It covers:

- what this repo is;
- which integration path to take;
- what changed for code that calls the old endpoints;
- how a frontend drives the new mirror flow;
- how to run it on the mirror machine.

API details live in [backend/README.md](backend/README.md#api-v2-mirror), and camera and calibration details
in [sidecar/README.md](sidecar/README.md). This guide links to them rather than repeating them.

## 1. What is in this repo

```
 Mirror machine (one computer, macOS)
 ┌──────────────────────────────────────────────────────────────────────────────────┐
 │  Tauri frontend (team's app)                                                     │
 │      │  HTTP + Server-Sent Events, Bearer token                                  │
 │      ▼                                                                           │
 │  backend/  Node 24, Fastify, port 3000 ── HTTPS ──▶ OpenAI (design + image)      │
 │      │  spawns and supervises; HTTP on 127.0.0.1, sidecar token                  │
 │      ▼                                                                           │
 │  sidecar/  Python 3.12, port 8765: camera, pose, face mesh, skin tone, height,   │
 │            masks, identity check. Never called by the frontend directly.         │
 └──────────────────────────────────────────────────────────────────────────────────┘
```

| Folder | What it is |
|---|---|
| `backend/` | The API the frontend talks to: the **v2 mirror pipeline** (`/api/v2/*`) plus the **old v1 endpoints**, kept at the same paths. |
| `backend/dev/` | `mirror.html` (a complete working frontend for the v2 flow: use it as the reference implementation), `dashboard.html` (operations). |
| `sidecar/` | Camera and on-device perception. Started by the backend, so nothing else needs to launch it. |
| `backend/reports/`, `sidecar/reports/` | Test evidence: token comparison, undertone benchmark workbook, security audit. |
| `.github/workflows/test.yml` | CI: both test suites and dependency audits on every push. |

This repo started from the team's `openday-develop` folder on 5 November 2026. That folder held the original
Fastify server, the outfit catalogue (`backend/data/*.json`) and `Ripples.html`. It did **not** hold the Tauri
app, the `wardrobe/` images the catalogue points to, or any later changes the team made elsewhere.

## 2. Choose an integration path

| | **A. Replace the old backend (recommended)** | **B. Keep the old backend alongside** |
|---|---|---|
| What runs | This backend only. It serves the old v1 paths and the new v2 mirror API. | The old backend for its own features, this backend for the mirror. |
| Frontend calls | One base URL (`http://127.0.0.1:3000`). | Mirror features go to this backend, everything else to the old one (or through it, see 5.2). |
| When to choose | The old backend is still essentially the 5 November server. | The old backend gained features since (accounts, catalogue admin, analytics) that this repo doesn't have. |
| Main work | Update the frontend for the v1 changes in section 3, then adopt v2 (section 4). | The same, plus CORS or proxy setup (section 5). |

Whichever you choose, **only one process may own the camera**. If the old backend or the frontend opens the
webcam itself, turn that off and use this backend's preview stream (`GET /api/v2/preview.mjpg`) instead.

## 3. The old v1 endpoints: what changed for callers

All five old routes still exist at the same paths, with the same request bodies and the same response fields.
What changed around them:

| Old endpoint | Status here | What a caller must change |
|---|---|---|
| `POST /api/outfit-review {imageDataUrl}` | Same response: `score`, `cards`, `working`, `notWorking`, … | Send the token (below). Photos that are black, dark, blank or tiny now get **422** `{code: "retake"}` before any paid call. |
| `POST /api/outfit-suggestion {gender, imageDataUrl}` | Same response, including `virtualTryOnJobId`. | Token. It needs the catalogue's garment images in `WARDROBE_DIR` (default `wardrobe/` next to `backend/`). **They were never in the folder**, so without them this returns 503. |
| `POST /api/handheld-virtual-tryon {imageDataUrl}` | Same response: `imageDataUrl`, `faceCheck`. | Token. |
| `GET /api/virtual-tryon/:jobId` | Same polling. Jobs are now removed from memory after `JOB_TTL_MINUTES` (10). | Token. A job unknown after a restart returns 404 or a `failed` status, so show "try again". |
| `GET /health` | Same, with more fields. | Nothing. Add `GET /ready` for "can it take visitors?". |
| *(new)* `POST /api/style-me`, `/api/style-me/:id/next`, `DELETE /api/style-me/:id` | Single-photo personalised styling (v1). | Optional. The v2 mirror flow replaces it. |

Rules that now apply to **every** `/api/*` call:

- **Token required.** Send `Authorization: Bearer <apiToken>` (or `x-api-key`). GET requests may use
  `?token=` instead, which `EventSource` and `<img>` need. A missing or wrong token gets **401**. See 6.1 for
  where the token comes from.
- **Host check.** Requests must be addressed to `localhost`, `127.0.0.1`, `HOST`, `PUBLIC_BASE_URL`'s host or
  a name in `ALLOWED_HOSTS`. Anything else gets **403** (this blocks DNS rebinding).
- **CORS.** Allowed by default: `http(s)://localhost` and `127.0.0.1` on any port, plus `tauri://localhost`
  and `http(s)://tauri.localhost`. Any other origin goes in `CORS_ORIGINS`.
- **Rate limit.** 10 paid requests per minute (`RATE_LIMIT_MAX`): per visitor session for session actions,
  per client address otherwise. Over the limit gets **429**.
- **Errors** are always JSON `{error, code?}`, and `error` is written for visitors. Spend over the daily cap
  (`DAILY_BUDGET_USD`, 30) degrades to text-only results instead of failing.
- **Photos are not saved to disk by default** (`RETENTION_HOURS=0`), so file fields in v1 responses
  (`artifacts.*File`, `imageFile`) are `null` or empty. Set `RETENTION_HOURS` only for debugging, and never at
  a public event.

## 4. Building the mirror flow in the frontend (v2)

`backend/dev/mirror.html` does all of this in about 400 lines of plain JavaScript. Copy its patterns. The flow:

1. **Show the camera:** `<img src="http://127.0.0.1:3000/api/v2/preview.mjpg?token=…">`.
2. **Open the event stream once:** `GET /api/v2/events?token=…`. Before a session exists it carries guidance
   (`perception`: "step back", "hold still"…), `presence`, `camera` and `gesture` events.
3. **Start a session** when the visitor has picked a style and ticked consent:
   `POST /api/v2/sessions {style, consent: true, gender?, heightCm?, preferences?}`. The camera then captures
   them automatically once they hold a ready pose. Or send `imageDataUrl` to use a photo upload instead.
4. **Reopen the stream with `?sessionId=`.** A stream not scoped to the session receives that session's images
   and share links as `null` (other visitors' photos stay private). On the new stream's `hello` event, call
   `GET /api/v2/sessions/:id` to fill in anything missed while reconnecting.
5. **React to events:**

| Event | Show |
|---|---|
| `session.skin` | The undertone, read from the face before the full-body capture. |
| `session.profile` | The measured profile and palette. Ask "looks right?" when `profile.skinMeasurement.requireConfirmation` is true. |
| `session.option` / `session.options` | Outfit ideas, as they stream in, then the final order. |
| `session.render.partial` / `.done` | Preview and final image (`imageDataUrl`). |
| `session.degraded` / `session.recovered` | Text-only mode: images are unavailable for now, or the budget is spent. Show `message`. |
| `session.error`, `session.render.failed` | `error` is visitor-ready text. |
| `session.ended` | `reason`: `visitor_left`, `ended_by_visitor`, `timeout` or `replaced`. Return to the start screen. |

6. **Visitor actions:**
   - `POST …/next` (another look), `…/rate {round, option, rating}`, `…/keep {round, option}` (returns a QR code
     and link), `…/redesign {feedback?}`, `…/profile {skinUndertone?…}` (correct the profile),
     `…/profile/confirm`, `DELETE …` (done, forget me).
   - Gestures (thumbs up, thumbs down, victory) are handled by the backend and also arrive as events.

Minimal version:

```js
const API = 'http://127.0.0.1:3000';
const TOKEN = kioskToken;                       // see 6.1
const json = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };
let stream;

function listen(sessionId) {
  stream?.close();
  const q = new URLSearchParams({ token: TOKEN, ...(sessionId ? { sessionId } : {}) });
  stream = new EventSource(`${API}/api/v2/events?${q}`);
  const on = (type, fn) => stream.addEventListener(type, (e) => fn(JSON.parse(e.data)));
  on('perception', (e) => showGuidance(e.message));
  on('session.option', (e) => addOption(e.option));
  on('session.render.done', (e) => e.imageDataUrl && showLook(e.imageDataUrl));
  on('session.ended', () => backToStart());
  on('hello', async () => sessionId && restore(await (await fetch(`${API}/api/v2/sessions/${sessionId}`, { headers: json })).json()));
}

listen();                                       // guidance before anyone starts
const res = await fetch(`${API}/api/v2/sessions`, { method: 'POST', headers: json, body: JSON.stringify({ style: 'office', consent: true }) });
if (!res.ok) showError((await res.json()).error); // e.g. 400 consent_required, 503 camera unavailable
const { sessionId } = await res.json();
listen(sessionId);                              // now this visitor's images arrive too
```

**Visitor behaviour the frontend can rely on:**
- A visitor walking up to the screen to look at their result keeps it.
- The session ends after 12 seconds with no body *and* no face in view (`ABSENT_AFTER_MS`, set on the
  sidecar), or when they press done.

## 5. If the old backend stays (path B)

### 5.1 Frontend calls both backends directly

- Point mirror features at this backend's base URL, and everything else at the old one.
- If the frontend runs from an origin not in the default list, add it to `CORS_ORIGINS`.
- Run the old backend on a different port: `PORT` here defaults to 3000.

### 5.2 The old backend proxies to this one

Useful if the frontend should keep a single base URL:

- Forward `/api/v2/*`, `/looks/*` and `/ready` to `http://127.0.0.1:3000`, adding
  `Authorization: Bearer <apiToken>` server-side. The frontend then never holds the token.
- **Keep the event stream unbuffered.** Stream the response through as it arrives, don't collect it, and
  don't time it out. Responses already send `x-accel-buffering: no` for nginx.
- **Host header:** send `Host: 127.0.0.1:3000`, or add the proxy's hostname to `ALLOWED_HOSTS`.
- **Don't log query strings.** `?token=` and `/looks/<token>` URLs are secrets. This backend redacts them in its
  own logs; the proxy must too.
- `preview.mjpg` is a never-ending multipart stream; proxy it like the event stream.

### 5.3 Data the old backend may want

| Data | Where |
|---|---|
| Outfit catalogue | `backend/data/{male,female}{,_outfits}.json` (unchanged from the original folder) |
| Ratings and profile corrections | `backend/.runtime/ratings.jsonl`, `corrections.jsonl` on the mirror machine: anonymous, one JSON object per line |
| Spend, timings, counters | `GET /api/v2/metrics` (operator token) |
| Live status | `GET /health`, `GET /ready` |

## 6. Configuration that matters for integration

All settings are in [backend/.env.example](backend/.env.example), and `.env` values override shell variables.
Never commit `.env`; `.gitignore` already excludes it, along with `.runtime/`.

### 6.1 Tokens

- On first start the backend generates `apiToken` and `operatorToken` into `backend/.runtime/secrets.json`
  (owner-only), and keeps them across restarts.
- For the Tauri app, the simplest option is to set `API_TOKEN` (and `OPERATOR_TOKEN`) explicitly in
  `backend/.env` during installation and give the same value to the app's local config. Alternatively the app
  reads `apiToken` from that file at start-up.
- The operator token is only for staff screens (calibration, metrics). Never put it in the visitor-facing app.

### 6.2 Settings to review

| Setting | Default | Change it when |
|---|---|---|
| `PORT`, `HOST` | `3000`, `127.0.0.1` | Another service uses 3000, or another device must reach the API (then also set `ALLOWED_HOSTS` and use TLS). |
| `CORS_ORIGINS` | localhost + Tauri | The frontend is served from another origin. |
| `ALLOWED_HOSTS` | — | Clients reach the backend by a LAN name or IP. |
| `EVENT_STREAM_IMAGES` | `session` | Temporarily `all`, while a frontend can't yet pass `?sessionId=`. |
| `REQUIRE_CONSENT` | `true` | Keep it on: photos go to OpenAI. |
| `PUBLIC_BASE_URL`, `TLS_CERT_FILE`, `TLS_KEY_FILE` | — | Phones should open "take it home" QR links. These need HTTPS, and keeping looks is refused over plain HTTP on a network. |
| `FINAL_QUALITY` | `medium` (about $0.07 a look) | `low` for about $0.03 a look, at visibly lower quality. |
| `DAILY_BUDGET_USD` | `30` | The expected visitors × cost per look. |
| `SIDECAR_SPAWN` | `auto` | `false` if the sidecar is started some other way. Then set `SIDECAR_TOKEN` to the same value in both. |
| `ALERT_WEBHOOK_URL` | — | A Slack-compatible webhook for budget, camera and crash alerts. |

## 7. Running it on the mirror machine

```bash
git clone https://github.com/Tanush-410/Kyra-backend.git && cd Kyra-backend
cd backend && cp .env.example .env            # set OPENAI_API_KEY (and API_TOKEN / OPERATOR_TOKEN if fixed)
npm install
cd ../sidecar && python3.12 -m venv .venv && .venv/bin/pip install -r requirements.txt \
  && .venv/bin/python scripts/download_models.py
cd ../backend && npm start                     # starts the sidecar too; allow camera access when macOS asks
curl -s http://127.0.0.1:3000/ready            # {"ready":true,"problems":[]}
```

Then:

- **Run it permanently:** `backend/deploy/launchd.sh install` (starts at login, restarts within seconds if it exits).
- **Calibrate once on site:**
  - height: one person of known height;
  - grey card: a matte card kept in view, which makes undertone reliable (299 of 300 right in the benchmark);
  - later, `npm run tune-thresholds` once visitors have confirmed or corrected their undertone.

  See [sidecar/README.md](sidecar/README.md#calibration-once-per-installation).
- **Operations screen:** `backend/dev/dashboard.html` with the operator token. Logs are in
  `backend/.runtime/logs/`.

## 8. Checklist for the integration

- [ ] Confirm what the team's current backend and frontend contain beyond the 5 November `openday-develop`
      snapshot. This repo can't know.
- [ ] Choose path A or B (section 2).
- [ ] Frontend: send the kiosk token on every call; handle 401, 403, 422 `retake`, 429 and 503.
- [ ] Frontend: move capture to the backend's camera flow (section 4) and stop opening the webcam itself.
- [ ] Frontend: scope the event stream to the session; handle `session.degraded` and `session.ended`.
- [ ] If `/api/outfit-suggestion` is still used: provide the `wardrobe/` images and set `WARDROBE_DIR`.
- [ ] Set tokens, `CORS_ORIGINS` and `ALLOWED_HOSTS` for your setup; set up TLS if phones will scan QR codes.
- [ ] Run `npm run check` (both test suites) and `npm run soak -- 30` (long run with failures injected).
- [ ] Rehearse end to end with real visitors and `npm run mock-openai` (free).
- [ ] Calibrate on site (height, grey card), install the supervisor, set `ALERT_WEBHOOK_URL`.

## 9. Known limits

- **Not seen by this repo:** the Tauri app, the wardrobe images, and any team backend changes after 5 November.
- **Undertone:** without a grey card, about 80% right in the benchmark, and less reliable for skin near the
  cool/neutral boundary. The mirror asks visitors to confirm unless it is sure.
- **Image cost:** about $0.07 a look at medium quality. Medium-quality renders haven't been reviewed with real
  visitors yet.
- **Security:** the audit (`backend/reports/security-audit-2026-11-07.md`) lists every fix. Still open: a Python
  dependency audit (it runs in CI) and a review of the Tauri app.
