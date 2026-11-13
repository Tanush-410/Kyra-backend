# Integrating this repo with the existing KYRA frontend and backend

This repo holds the KYRA mirror backend and the camera sidecar. This guide is for the engineers who connect
it to the team's mirror frontend and to the backend the team built before. The team's React kiosk UI
([Kyra-UI-V1](https://github.com/minalkrishnadev-cpu/Kyra-UI-V1)) is included in this repo, in `Kyra-UI-V1/`,
already connected: see [section 4.1](#41-the-teams-kiosk-ui-kyra-ui-v1). This guide covers:

- getting it running on your machine (**start here**);
- what this repo is;
- which integration path to take;
- what changed for code that calls the old endpoints;
- how a frontend drives the new mirror flow;
- running it on the mirror machine;
- troubleshooting, by the exact message you see.

API details live in [backend/README.md](backend/README.md#api-v2-mirror), and camera and calibration details
in [sidecar/README.md](sidecar/README.md). This guide links to them rather than repeating them.

## Quick start: run it on your machine (about 10 minutes)

You need a Mac (Linux works the same way; on Windows, use WSL), **Node 22 or newer**, and an internet
connection. Don't install Python yourself: the setup script handles it.

**1. Set up** (safe to run again at any time):

```bash
git clone https://github.com/Tanush-410/Kyra-backend.git
cd Kyra-backend
./setup.sh
```

It installs the Node packages, a private Python 3.12 environment for the camera sidecar and the AI models,
builds the kiosk UI, and creates `backend/.env`. When something is missing it says exactly what to do. The usual case: **"Python 3.12
is not installed"**. Run the one-line `uv` install it prints, open a new terminal, and run `./setup.sh` again.

**2. Add the OpenAI key** to `backend/.env` (`OPENAI_API_KEY=sk-...`), or pass it during setup:
`OPENAI_API_KEY=sk-... ./setup.sh`. You can skip this step if you only use the rehearsal in step 3.

**3. Start it:**

```bash
cd backend
npm start           # the real thing (uses the OpenAI key)
npm run rehearse    # or: everything with a fake OpenAI, free, no key needed
```

On the first start, macOS asks to let your terminal app (Terminal, iTerm or VS Code) use the camera: allow it,
then stop (Ctrl+C) and start again. The camera takes up to **30 seconds** to come up the first time.

**4. Open the mirror.** In a second terminal, run `cd backend && npm run links` and open the **Kiosk UI** link
it prints (`http://localhost:3000/Kyra-UI-V1/#token=…`): the team's screens, with the live camera behind the
hold-still screen. Wave, or click, to start. The **Mirror console** link is the backend's own test page: it
should show **connected** and **camera running**. Both links include your access token, so there's nothing to
paste.

**Something wrong?** Run `./setup.sh --check` (or `npm run doctor` in `backend/`). It checks every piece and
prints the fix. Then see [Troubleshooting](#10-troubleshooting).

**No webcam, or a Windows machine?** Start with `CAMERA=false npm start`. Everything works except the live
camera; use "Upload photo" in the console with a full-body picture.

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
| `backend/dev/` | `mirror.html` (a complete working frontend for the v2 flow: use it as the reference implementation), `dashboard.html` (operations). The backend serves both at `http://localhost:3000/console/`. |
| `Kyra-UI-V1/` | The team's React kiosk UI, connected to this backend. The backend serves its build at `http://localhost:3000/Kyra-UI-V1/` (section 4.1). A copy of [the team's repo](https://github.com/minalkrishnadev-cpu/Kyra-UI-V1) with the integration added: send UI changes there too. |
| `setup.sh` | One-command setup, and `--check` diagnostics. |
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

### 4.1 The team's kiosk UI (Kyra-UI-V1)

The React UI already implements the whole flow below. Its README has the details; in short:

| | |
|---|---|
| **Served by** | This backend, at `/Kyra-UI-V1/` (`FRONTEND_DIR`, default `Kyra-UI-V1/dist`). One origin: no CORS, and the token never sits in the build. |
| **Token** | The kiosk link's `#token=…` (from `npm run links`) is stored once in the browser and removed from the address bar. |
| **Camera** | The backend owns it. The UI turns `/api/v2/preview.mjpg` into the video its hand tracking and camera screens use, so pinch, wave and the hold-still view work unchanged. |
| **Flow** | Splash (wave) → How can I help you today? → (just browsing → What are you looking for? → Outfit, or pick a piece; or the voice path) → Build your profile → analysis intro → **consent** (starts the session; QR to the privacy page) → hold still (the camera's guidance, a 3-2-1 from `holdMs`, flash, All set) → **Skin Tone Analysis** → **Fit Analysis** → **Suggestions** (swipe the outfits of every set; Virtual try-on, Edit outfit and More like this, both via `…/redesign`, one at a time) → **virtual try-on** (tap for Love it / Take it home / Show another / Back to suggestions; a failed or text-only look shows the outfit in words with Try again / Try another look). The look renders in the background meanwhile; both analysis screens can skip to it. |
| **Choices** | The picks and voice text become the session's `style` and `gender` (`src/lib/visitIntent.js`): "tops-female" becomes gender female, "…built around a top". |
| **State** | `src/context/KyraSessionContext.jsx` (one event stream, scoped to the session) and the pure reducer `src/state/sessionReducer.js` (unit-tested). |
| **Develop** | `npm run dev` in `Kyra-UI-V1/` forwards `/api` to this backend. `VITE_CAMERA_SOURCE=browser` uses the browser's webcam and uploads the photo instead (a UI on another machine). |
| **Rebuild** | After changing the UI: `cd Kyra-UI-V1 && npm run build`, then reload. No backend restart needed. |

The hold-still countdown matches the camera: `READY_HOLD_MS` (sidecar) now defaults to 3000, and `perception`
events carry `holdMs` (how long to hold) next to `heldMs` (held so far).

### 4.2 Any other frontend

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
| `session.render.partial` / `.done` | Preview (none by default) and final image (`imageDataUrl`). `.done` can come again for the same look with `upgraded: true` when a clearer face was placed on it: replace the image. |
| `session.degraded` / `session.recovered` | Text-only mode: images are unavailable for now, or the budget is spent. Show `message`. |
| `session.error`, `session.render.failed` | `error` is visitor-ready text. |
| `session.leaving` / `session.stayed` | The camera lost the visitor: show "Still here?" counting down to `endsAt`; `stayed` (back in view, or `…/still-here`) hides it. |
| `session.ended` | `reason`: `visitor_left`, `ended_by_visitor`, `timeout` or `replaced`. Return to the start screen. |

6. **Visitor actions:**
   - `POST …/next` (another look), `…/rate {round, option, rating}`, `…/keep {round, option}` (returns a QR code
     and link), `…/redesign {feedback?}`, `…/profile {skinUndertone?…}` (correct the profile),
     `…/profile/confirm`, `DELETE …` (done, forget me).
   - `POST …/results` ("Your results": a QR to a temporary page of the visit's undertone, colours, fit notes and any look taken home; like `keep`, private link, `KEEP_HOURS`).
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
- With no body *and* no face in view for 10 s (`ABSENT_AFTER_MS`, on the sidecar), the camera reports the
  visitor gone: `session.leaving` with `endsAt` (now + `LEAVE_GRACE_MS`, 30 s). The kiosk shows "Still
  here?" with the countdown. Back in view, or `POST …/still-here`, cancels it (`session.stayed`); otherwise
  the session ends (`visitor_left`). Pressing done ends it at once.

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

All settings are in [backend/.env.example](backend/.env.example). `backend/.env` holds your values. A setting
given on the command line wins for that run (`PORT=3100 npm start`). Restart after editing `.env`. Never commit
`.env`; `.gitignore` already excludes it, along with `.runtime/`.

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
| `PRIVACY_URL` | — | The venue has its own privacy notice: the consent screen's QR code opens it. Without it the QR opens the backend's `/privacy` page, and only when `PUBLIC_BASE_URL` is set. |
| `FINAL_QUALITY` | `medium` (about $0.06 a look) | `low` for about $0.03 a look, at visibly lower quality. |
| `PREFETCH_OPTIONS`, `EARLY_DESIGN`, `PARTIAL_IMAGES` | `false`, `false`, `0` | Token savings. Turn on for speed: ready "next look", first idea ~5 s sooner, previews while rendering, each at a token cost. |
| `DAILY_BUDGET_USD` | `30` | The expected visitors × cost per look. |
| `SIDECAR_SPAWN` | `auto` | `false` if the sidecar is started some other way. Then set `SIDECAR_TOKEN` to the same value in both. |
| `ALERT_WEBHOOK_URL` | — | A Slack-compatible webhook for budget, camera and crash alerts. |

## 7. Running it on the mirror machine

Install exactly as in the [Quick start](#quick-start-run-it-on-your-machine-about-10-minutes) (`./setup.sh`, the key in
`backend/.env`, `npm start`). Check `./setup.sh --check` ends with **Ready**, and that
`curl -s http://127.0.0.1:3000/ready` returns `{"ready":true,"problems":[]}`. Then:

- **Fix the tokens** the frontend will use: set `API_TOKEN` and `OPERATOR_TOKEN` in `backend/.env` (see 6.1)
  and restart.
- **Run it permanently:** `backend/deploy/launchd.sh install` (starts at login, restarts within seconds if it
  exits). Allow camera access for `node` when macOS asks.
- **Camera on its side** (a portrait mount): stand facing it with the backend running, then
  `cd backend && npm run camera-check -- --apply` and restart. It finds the face in the live picture and
  writes the right `CAMERA_ROTATION` (90 or 270 depending on which way the camera was turned) to
  `backend/.env`. Run it again after a restart: it should say "the right way up".
- **Calibrate once on site:**
  - height: one person of known height;
  - grey card: a matte card kept in view, which makes undertone reliable (299 of 300 right in the benchmark);
  - later, `npm run tune-thresholds` once visitors have confirmed or corrected their undertone.

  See [sidecar/README.md](sidecar/README.md#calibration-once-per-installation).
- **Operations screen:** the Operations dashboard link from `npm run links` (`/console/dashboard.html`). Logs
  are in `backend/.runtime/logs/`.
- **The screen:** open the Kiosk UI link full-screen in Chrome or Edge: `open -a "Google Chrome" --args --kiosk "<link>"`.
  The UI is designed for a 1080 × 3840 portrait display and scales to fit. Allow the microphone for voice search.

## 8. Checklist for the integration

- [ ] Every developer machine: `./setup.sh --check` ends with **Ready**, and the console from `npm run links` shows connected.
- [ ] Confirm what the team's current backend and frontend contain beyond the 5 November `openday-develop`
      snapshot. This repo can't know.
- [ ] Choose path A or B (section 2).
- [x] Kiosk UI (Kyra-UI-V1): token on every call and error handling; capture by the backend's camera (it no
      longer opens the webcam itself); stream scoped to the session; `session.degraded` and `session.ended`
      handled (section 4.1).
- [ ] Any other frontend (the Tauri app, if it is separate): the same three points, following section 4.2.
- [ ] If `/api/outfit-suggestion` is still used: provide the `wardrobe/` images and set `WARDROBE_DIR`.
- [ ] Set tokens, `CORS_ORIGINS` and `ALLOWED_HOSTS` for your setup; set up TLS if phones will scan QR codes.
- [ ] Run `npm run check` (both test suites) and `npm run soak -- 30` (long run with failures injected).
- [ ] Rehearse end to end with real visitors and `npm run rehearse` (free).
- [ ] Calibrate on site (height, grey card), install the supervisor, set `ALERT_WEBHOOK_URL`.

## 9. Known limits

- **Not seen by this repo:** the Tauri app (if separate from Kyra-UI-V1), the wardrobe images, and any team
  backend changes after 5 November.
- **Kiosk UI:** the "Pick a piece" choice steers the design ("built around a top"); there is no per-piece
  catalogue yet. The profile icon in the header has no screen behind it.
- **Undertone:** without a grey card, about 80% right in the benchmark, and less reliable for skin near the
  cool/neutral boundary. The mirror asks visitors to confirm unless it is sure.
- **Image cost:** about $0.07 a look at medium quality. Medium-quality renders haven't been reviewed with real
  visitors yet.
- **Security:** the audit (`backend/reports/security-audit-2026-11-07.md`) lists every fix. Still open: a Python
  dependency audit (it runs in CI) and a review of the Tauri app.

## 10. Troubleshooting

Run `./setup.sh --check` first: it checks every piece below and prints the fix. Find the exact message you
see in the left column.

| You see | Why | Fix |
|---|---|---|
| `python3.12: command not found` | macOS doesn't include Python 3.12. | `./setup.sh` gets it for you via `uv`. If it says "Python 3.12 is not installed", run the `uv` install line it prints, open a new terminal, and run `./setup.sh` again. |
| `No matching distribution found for numpy==2.5.4` (or for `mediapipe`) | The environment was built with macOS's Python 3.9, which is too old. | `./setup.sh`: it sets the old `sidecar/.venv` aside and builds a 3.12 one. |
| `.venv/bin/pip: No such file or directory` | The environment was made by `uv`, which leaves out `pip`. | `./setup.sh` installs with `uv` in that case. |
| `/ready` shows `sidecar_unavailable` | On the first start the sidecar loads its AI models (up to 30 s). Or the sidecar failed to start. | Wait 30 s. If it stays, run `./setup.sh --check`, and read `backend/.runtime/logs/` for lines from the sidecar. |
| Console says **camera error**, or the preview stays black | macOS hasn't allowed the camera, or another app is using it. | System Settings → Privacy & Security → Camera: allow your terminal app (or `node` under launchd). Quit Zoom, FaceTime, Photo Booth, or a frontend that opens the webcam itself. Restart `npm start`. |
| Console says **token needed** or **wrong token**; API calls return **401** | Every `/api` call needs the access token. | Open the console from `npm run links`. In your own frontend, send `Authorization: Bearer <apiToken>` (or `?token=` for `EventSource` and `<img>`). Tokens: `backend/.runtime/secrets.json`, or the values you set in `.env`. |
| Metrics or calibration say they need the **operator token** | Staff-only routes. | Use the Operations dashboard link from `npm run links`. |
| `/Kyra-UI-V1/` says "The kiosk UI is not built yet" | `Kyra-UI-V1/dist` doesn't exist. | `cd Kyra-UI-V1 && npm ci && npm run build` (or `./setup.sh`), then reload. If the UI lives elsewhere, set `FRONTEND_DIR`. |
| Kiosk UI shows a red bar "This mirror needs its kiosk link" | The browser has no kiosk token (opened without `#token=…`, or the backend's tokens changed). | Open the Kiosk UI link from `npm run links` once; the browser keeps the token. |
| Kiosk UI hold-still screen stays on "Getting ready…" or "Camera unavailable" | The backend camera isn't running. | `curl -s localhost:3000/ready`, then the camera rows below. The console's **camera** pill shows the same. |
| Kiosk UI clicks things by itself | Hand tracking sees a hand (pinch = click) on the camera, often someone near the screen. | Expected on a busy camera. Keep hands down while testing with a mouse. |
| `EADDRINUSE` / "port 3000 is used by another program" | Something else (often the old backend or a frontend dev server) is on port 3000. | Stop it, or `PORT=3100 npm start` (or put `PORT=3100` in `.env`). The console and `npm run links` follow the port. Point your frontend at the new port. |
| **403** "Host not allowed" | The backend was reached by a name that isn't localhost (a LAN IP, a `.local` name, a proxy). | Add that name to `ALLOWED_HOSTS` in `.env`, or make the proxy send `Host: 127.0.0.1:3000`. |
| Browser console shows a **CORS** error | The frontend's origin isn't allowed. | Add it to `CORS_ORIGINS`, for example `CORS_ORIGINS=http://localhost:5173,tauri://localhost`. Localhost on any port and Tauri are allowed by default. |
| `OPENAI_API_KEY is not set`, or `/ready` shows `openai_not_configured` | `.env` still has the example placeholder. | Put your key in `backend/.env` and restart. For a free run, use `npm run rehearse`. |
| Renders fail with an OpenAI **401/403** | The key is wrong, or its organisation can't use the image model (OpenAI has required organisation verification for its image models). | Check the key, and the organisation's verification and model access, in the OpenAI dashboard. |
| A change in `.env` has no effect | The backend reads `.env` only at start, and a value given on the command line wins. | Restart. Check you aren't also setting it on the command line or in your shell profile. |
| `npm ci` fails, or Node says a feature is missing | Node is older than 22. | Install Node 24 LTS (`nvm install 24`, or nodejs.org). |
| The visitor's look disappears | They were out of view (no body and no face) for about 40 s (`ABSENT_AFTER_MS` 10 s, then the "Still here?" countdown, `LEAVE_GRACE_MS` 30 s), or pressed done. | Expected. Raise `LEAVE_GRACE_MS` (backend) for a slower kiosk flow. |
