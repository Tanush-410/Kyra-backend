# KYRA Smart Mirror — backend

The mirror's orchestrator. A visitor picks what they're dressing for and holds still. The camera sidecar
measures their skin tone, height and build. The backend then designs three outfits in colours that suit
them and renders them wearing the first one, with their real face kept intact. The mirror UI receives
every step as a live event.

```
 Python sidecar (on device, free)         Node backend                              Mirror UI
 ─────────────────────────────────        ───────────────────────────────────        ──────────
 camera → pose + face mesh                1 palette from rules (measured skin)       SSE events:
 live guidance ("step back")  ──events──▶ 2 one streamed LLM call → 3 options ─────▶ perception
 auto-capture when ready                  3 option 1 renders as soon as it streams   session.option
 skin Lab over 15 frames, height,         4 draft + final gpt-image edits            session.render.draft
 build, masks, face embedding             5 sidecar: warp render onto the capture,   session.render.done
 gestures (👍 👎 ✌️)            ──────────▶   paste real head + hands, black bg,      session.gesture
 visitor left → forget                        identity check                         session.ended
 camera watchdog                          6 prefetch other options when idle
```

## Run

```bash
# once
cp .env.example .env                      # set OPENAI_API_KEY
npm install
cd ../sidecar && python3.12 -m venv .venv && .venv/bin/pip install -r requirements.txt \
  && .venv/bin/python scripts/download_models.py && cd ../backend

npm start      # starts the backend and the sidecar it finds in ../sidecar/.venv
npm test       # offline tests; OpenAI and the sidecar are mocked
```

Open the console for testing: `cd dev && python3 -m http.server 8080`, then go to
`http://localhost:8080/mirror.html`. It has consent, the live preview, guidance (with optional
voice), options, draft and final images, likes and dislikes, profile correction, QR code,
calibration and metrics. `dashboard.html` is the operations view: spend, camera, queue, timings,
ratings and profile corrections, with alerts. The older single-shot page is `style-me.html`.

**Rehearse for free:** run `npm run mock-openai` in one terminal, then
`OPENAI_BASE_URL=http://127.0.0.1:4010/v1 npm start`. The mock returns three fixed outfits and tints
the visitor's clothes, so the whole flow runs without spending credit.

**Load test:** `npm run loadtest -- 20 0.05 2` runs 20 simultaneous visitors at 1/20 speed with 2 render
slots, against the real orchestration with OpenAI and the sidecar faked.

All settings are in [.env.example](.env.example). Values in `.env` override shell variables.

## Pipeline details

| Step | Where | Cost | Typical time |
|---|---|---|---|
| Guidance and auto-capture | sidecar, live | free | real-time |
| Skin (face mesh, 15 frames), height (calibrated), build, masks | sidecar | free | < 0.2 s |
| Palette and fit rules from the measured profile | backend, code | free | instant |
| Outfit design: 3 options, structured JSON, streamed (started before the photo when possible) | OpenAI text | ~$0.01 (measured) | first option ~5–9 s, all ~11–16 s |
| Render of option 1 (starts when option 1 streams in, or at capture if designed early) | OpenAI image edit | $0.019 low / ~$0.06 medium (measured) | 15–50 s (varies by OpenAI load) |
| Align render, paste head and hands, black background, identity check | sidecar | free | ~0.3 s |
| Next look in the background after 10 s of viewing (`PREFETCH_OPTIONS=dwell`) | OpenAI image edit | same as above | only if the visitor stays |

Notes from real runs:

- **The render is unmasked by default.** With `gpt-image-1.5`, a clothing mask made the model copy the
  input and ignore the prompt. So the default edit sends no mask and tells the model to keep the pose and
  framing. `RENDER_MASK=true` brings the mask back for models that respect it.
- **Image quality (changed 7 Nov 2026):** final images are **medium** quality with `input_fidelity=high`
  (keeps the visitor's face and features; dropped automatically if the model rejects it), about $0.07 a
  look. In real use, low-quality renders looked too rough. `FINAL_QUALITY=low` and `LOOK_TOKEN_BUDGET=2600`
  bring back the cheap setting below.
- **Token rule (cheap setting):** every look must use fewer tokens than the original pipeline (2,673 measured on real
  calls). The cheap setting is a low-quality final image, a compressed design prompt and render prompt, and
  `LOOK_TOKEN_BUDGET=2600`. Optional extra calls (drafts, face-check retries, early designs) only run if
  the look stays under the budget. Each `session.render.done` reports `tokens: { design, image, total,
  original, underOriginal }`, and the dashboard shows the median. Measured: **1,857–1,970 tokens and about
  $0.028 per look, against 2,673 tokens and $0.060 for the original**. A sharp face close-up sent as a
  second image adds about 190 tokens.
- **The visitor's own body (silhouette matching):** after alignment, the render's body outline is
  matched to the visitor's, row by row from the neck to the ankles. It works within stretches that show
  the same body parts (arm | torso | arm), with smoothed edges and a fade at each stretch's ends.
  Garments may stay up to 12% wider than the body, never narrower. Measured on a real render: the
  outline went from 5–10% off to 0.4–1.9%. It's free; no regeneration.
- **Real head and hands** (sidecar `/compose`):
  1. The render is warped onto the capture using body landmarks (scale, rotation and shift only), because
     image models often redraw the person a few percent larger or offset.
  2. If the face then lines up (within 3% of position and 10% of size), the original face and hair (not
     the neck or collar) are pasted back through a soft mask, so the face is pixel-exact. **The exception
     is a soft capture:** if the camera face had to be enlarged 1.4× or more (a webcam far away), pasting
     it would look blurry on a sharp render. So the render's face is kept if it passes the identity
     check, using the sharpest close-up the camera saw during the visit as the reference. That close-up
     is also sent to the image model as a second image.
  3. Each hand that lines up (within 2.5%) is pasted back too, skin pixels only, so old sleeves never return.
  4. The background is blacked out with a feathered matte that never cuts into clothing.
- **Draft (off by default):** a low-quality draft can run alongside the final render (`RENDER_DRAFT=true`).
  Real runs showed it costs about 30% of a final image to save 2–8 s.
- **Designed before the photo:** while the visitor is still getting into position, the sidecar sends a
  stable early profile (8+ skin frames). The backend designs the outfits then, without publishing them.
  If the capture's profile matches (same undertone, depth, height group and build), that round is reused
  and option 1 renders immediately. Otherwise it is discarded and a new round is designed, wasting about
  $0.01. The saving equals however long the visitor took to get ready, up to the ~6 s design time.
- **Quality A/B test (`FINAL_QUALITY_EXPERIMENT=low,medium`):** visitors alternate between low and medium
  final images. Likes and real cost per quality are on the dashboard. Measured: low ≈ $0.019, medium ≈ $0.06 per image.
- **Dwell prefetch (`PREFETCH_OPTIONS=dwell`):** the next look renders only after the visitor has looked
  at the current one for 10 s and is still in front of the mirror, one look ahead at a time.
- **Colour harmony** (`src/lib/harmony.js`, no tokens): each item first snaps to the nearest palette
  colour by CIEDE2000. Then the outfit's colours are checked against each other:
  - Fashion neutrals (black, white, grey, cream, navy, denim, camel, brown, khaki, olive drab) go with anything.
  - Accent hues are compared on the painter's (RYB) wheel. Same family, analogous, triadic,
    split-complementary and complementary all pass; two loud hues 75-100 degrees apart clash.
  - At most two accent colours, or a triad whose third colour is an accessory.
  - 60-30-10: two loud complementary colours are not both big garments.
  - The top and bottom either match or clearly contrast.
  - Shoes are neutral or echo another colour.
  An outfit that fails is fixed by recolouring the smallest pieces first, staying inside the palette and
  close to the designer's choice. Colour words in item names that contradict the final colour are
  removed, so the image model never sees "Cobalt tux jacket, Denim #4A6A8E". The scheme is shown with
  each option.
- **Learning from likes:** once an undertone has `LEARN_MIN_RATINGS` ratings, its most-liked colours lead
  the palette and are named in the design prompt, least-liked ones are named as "use sparingly", and
  "show me another" follows the order of predicted appeal.
- **Undertone tuning:** "Looks right" confirmations and "Fix my profile" corrections are logged with the
  measured hue angle and L*a*b*. `npm run tune-thresholds` fits the sidecar's undertone detector to them
  and reports held-out accuracy against the defaults. `npm run tune-thresholds -- --save` applies the
  fit, and `POST /api/v2/calibrate/undertone {save}` does the same. It also still suggests the legacy
  `SKIN_COOL_MAX_HUE` / `SKIN_WARM_MIN_HUE` values (used only with `UNDERTONE_ENGINE=legacy`).
  No tokens are used.
- **The identity check** compares SFace embeddings locally: similarity ≥ 0.363 means the same person
  (OpenCV's threshold). If it fails, the image is regenerated once (`FACE_CHECK_RETRIES`) and the best
  attempt is kept. `faceCheck.passed=false` tells the UI to show a notice.
- **Colours are enforced in code.** Every item's colour is snapped to the nearest palette or neutral
  colour, and avoided colours are removed from the palette before the LLM sees it.
- **Degraded modes:** if the AI design fails, rule-based outfits are used (`source: "fallback"`). If the
  daily budget would be exceeded, the session goes text-only with no image call (`session.degraded`).
  If the sidecar is down, `/api/v2` returns 503, and the v1 routes still work with uploaded photos.

## API v2 (mirror)

All `/api/*` routes need `Authorization: Bearer <token>` (or `x-api-key`). GET routes also accept `?token=`,
because `EventSource` and `<img>` can't send headers; it is redacted from the logs. Tokens are on by default:
if `API_TOKEN` or `OPERATOR_TOKEN` is empty, it is generated on first start and kept in
`.runtime/secrets.json` (owner-only). The kiosk uses `apiToken`. Calibration (including its reset) and
`/api/v2/metrics` need `operatorToken`, which also works on every other route. Set a token to `off` only for
local development.

Every request must be addressed to `localhost`, `127.0.0.1`, `HOST`, `PUBLIC_BASE_URL`'s host or a name in
`ALLOWED_HOSTS`; anything else gets `403` (this stops DNS rebinding). Responses carry `nosniff`,
`no-referrer`, `DENY` framing and `no-store`; the share page also gets a strict content policy.

### `GET /api/v2/events[?sessionId=]` (Server-Sent Events)

Events, each with `type` and `at`, plus `sessionId` where relevant. Without `?sessionId=`, session events
arrive with `imageDataUrl`, `qrDataUrl` and `url` set to `null` (other visitors' photos and links stay private);
the operator token, or `EVENT_STREAM_IMAGES=all`, lifts this. A kiosk opens the stream once, then reopens it
with `?sessionId=` when it starts a session and fills any gap from `GET /api/v2/sessions/:id` (as
`dev/mirror.html` does). Global events (perception, presence, camera) arrive either way.

| type | data |
|---|---|
| `hello` | `sidecar`: camera status |
| `perception` | `state`, `message`, `ready`, `heldMs`, `armed`. States: `no_person`, `multiple_people`, `too_dark`, `too_close`, `too_far`, `move_left`, `move_right`, `not_standing`, `face_hidden`, `moving`, `blurry`, `ready` |
| `presence` | `present` |
| `camera` / `sidecar` | camera or sidecar connection status |
| `session.status` | `status` (`waiting_for_capture`, `designing`, `options_ready`, `rendering`, `ready`, `error`) and `message` |
| `session.profile` | `profile`, `palette`, `neutrals`, `paletteBasis`, `fitGuidance` |
| `session.option` | one option, as soon as it has streamed in |
| `session.options` | the round's final `options[]`, `source` (`ai` or `fallback`) and `order` (option numbers by predicted appeal) |
| `session.render.queued` | `round`, `option`, `position` |
| `session.render.started` / `.partial` / `.done` / `.failed` | `imageDataUrl` on partial and done; `faceCheck` on done; `error` on failed |
| `session.degraded` | `{ mode: "text-only", reason, message }`. `reason` is `budget` (for the rest of the day) or `images_unavailable` (the image service failed; asking for the look again retries) |
| `session.recovered` | images work again after `images_unavailable` |
| `session.subject` | a nearer person took over in front of the camera while waiting; outfits designed for the previous person were dropped |
| `session.render.draft` | quick low-quality `imageDataUrl` (replaced by `.done`) |
| `session.rated` | `round`, `option`, `rating` |
| `session.gesture` / `gesture` | `gesture` (`thumb_up`, `thumb_down`, `victory`, …) and the `action` taken (`like`, `next`, `keep`) |
| `budget.warning` | spend passed `BUDGET_WARN_FRACTION` of the cap |
| `session.kept` | `url`, `expiresAt`, `qrDataUrl` |
| `session.ended` | `reason`: `visitor_left`, `visitor_replaced` (a nearer person took over), `ended_by_visitor`, `timeout` or `replaced` |

### `POST /api/v2/sessions`

```json
{ "style": "wedding guest", "gender": "female", "heightCm": 168,
  "preferences": { "season": "summer", "weather": "hot", "avoidColors": ["black"], "modesty": "modest", "budget": "mid-range" },
  "imageDataUrl": "data:image/jpeg;base64,..." }
```

`style` is required. Without `imageDataUrl`, the sidecar is armed and the session waits for
auto-capture (`status: "waiting_for_capture"`). With it, the photo is analysed straight away. An unusable
upload returns `422 { code: "retake" }`: no person, several people, too dark, face hidden, cropped or
seated. A visitor-given `heightCm` overrides the camera's estimate. Returns `201` with a session snapshot.

`consent: true` is required (`400 { code: "consent_required" }` otherwise; `REQUIRE_CONSENT=false` to
disable). Photos are sent to OpenAI, so the UI must ask first.

### Other v2 routes

| Route | Purpose |
|---|---|
| `POST /api/v2/sessions/:id/profile {skinUndertone?, skinDepth?, heightCm?, build?}` | The visitor corrects the measurement. Rebuilds the palette, designs again, and logs the correction (with the measured hue angle) for threshold tuning |
| `POST /api/v2/sessions/:id/rate {round, option, rating: "up" or "down"}` | Like or dislike a look. Stored anonymously, with the final-quality variant, for palette learning and the A/B test |
| `POST /api/v2/sessions/:id/profile/confirm` | "Looks right": logs the measured undertone as confirmed, for threshold tuning |
| `POST /api/v2/sessions/:id/next` | Show the next look in order of predicted appeal (`202`; renders or replays it) |
| `GET /api/v2/sessions/:id` | Snapshot: profile, palette, rounds, renders (for reconnecting) |
| `POST /api/v2/sessions/:id/render {round, option}` | Render another option (`202`; result arrives as events) |
| `POST /api/v2/sessions/:id/redesign {feedback?, style?, preferences?}` | Three new options in one call; avoids repeats; renders option 1 |
| `POST /api/v2/sessions/:id/keep {round, option}` | Saves that look for `KEEP_HOURS`. Returns `{ url, qrDataUrl, expiresAt }` |
| `DELETE /api/v2/sessions/:id` | End now and forget the visitor |
| `GET /api/v2/preview.mjpg` | Live camera preview (proxied from the sidecar) |
| `GET` / `DELETE /api/v2/calibration`, `POST /api/v2/calibrate/height {heightCm}`, `POST /api/v2/calibrate/white-balance {roi}`, `POST /api/v2/calibrate/undertone {save?}` | Calibration (see sidecar README). The undertone fit uses the logged confirmations and corrections |
| `GET /api/v2/metrics` | Today's spend, queue, per-step timings (avg, p50, p90), counters, and `insights`: approval per undertone and measured hue angle by corrected undertone |
| `GET /looks/:token` | Public page for a kept look (the token is the access control), plus `/looks/:token.png` |
| `GET /health` | Always `200` while the process is up, with sidecar, budget and session details |
| `GET /ready` | `200` when the mirror can take visitors, else `503 { problems: [...] }`: `openai_not_configured`, `sidecar_unavailable`, `camera_<status>`, `daily_budget_spent`, `draining`. Point uptime monitors here |

Session actions are rate limited per visitor session; everything else per client address.
Visitor-facing error text is always plain (`VISITOR_MESSAGES` in `lib/mirror.js`); details go to the logs.

## Privacy

- In the v2 flow, visitor photos and measurements live **in memory only**. They are dropped when the
  visitor walks away (`AUTO_END_ON_LEAVE`), presses done, or is idle for `SESSION_TTL_MINUTES`.
- The only thing ever written to disk is a look the visitor explicitly keeps. It's one PNG behind a random
  32-hex-character link, deleted after `KEEP_HOURS`.
- v1 debug copies (`RETENTION_HOURS`) are off by default.
- Ratings and profile corrections are appended to `RUNTIME_DIR/ratings.jsonl` and `corrections.jsonl`.
  They hold no photos, names or session ids, only style, undertone, depth, build, colours and the
  measured hue angle.
- For phones to open the QR link, the backend has to be reachable from them. Set `HOST=0.0.0.0`,
  `PUBLIC_BASE_URL=https://<mirror-ip>:3000`, `TLS_CERT_FILE` and `TLS_KEY_FILE`, and **always**
  `API_TOKEN`. `/looks/*` stays public by design; `/api/*` requires the token.

## Reliability

- **Camera watchdog (sidecar):** the camera is reopened with backoff if it fails to open, stops sending
  frames, or freezes (5 s of byte-identical frames).
- **Sidecar watchdog (backend):** a spawned sidecar whose camera stops reporting for `SIDECAR_WATCHDOG_MS`
  is restarted.
- **Sidecar crashes:** a spawned sidecar that exits is restarted quickly (2–30 s) five times, then every
  5 minutes, never given up on. A run longer than 2 minutes resets the count.
- **Image outages:** outfits stay on screen as text (`images_unavailable`), and pictures come back on the
  next request once the service recovers. Design outages already fall back to rule-based outfits.
- **Errors:** an unhandled promise rejection is logged and alerted, not fatal. An uncaught exception is
  alerted, then the process exits so the supervisor starts a clean one.
- **Graceful shutdown:** on SIGTERM or SIGINT, new work gets `503 { code: "draining" }`, renders already
  paid for get up to `SHUTDOWN_GRACE_MS` to finish, then the process exits. A second signal exits at once.
- **Hands-free gestures** (sidecar, MediaPipe gesture recognizer): a gesture must be held for 0.6 s, then
  it is ignored for 2 s, so a wave doesn't trigger three actions.

## Running it for real

- **Supervisor (macOS):** `deploy/launchd.sh install` runs the backend as a LaunchAgent. It starts at
  login and restarts within seconds if it exits; `status` and `uninstall` too. On first start, allow
  camera access for `node`. Use Node 24 LTS (`.nvmrc`).
- **Alerts:** set `ALERT_WEBHOOK_URL` (Slack-compatible) to be told about the budget warning, camera errors,
  sidecar crashes or silence, repeated render or session failures, and backend crashes. Each alert is
  sent at most once per `ALERT_COOLDOWN_MINUTES`.
- **Logs:** `.runtime/logs/kyra-YYYY-MM-DD.log`, one file a day, kept `LOG_RETENTION_DAYS`. Tokens and
  kept-look links are redacted.
- **Metrics** are saved to `.runtime/metrics.json` every minute and on exit, so restarts don't reset the dashboard.
- **Tokens:** generated on first start into `.runtime/secrets.json`. Give the kiosk `apiToken` and the
  operators `operatorToken`. A sidecar the backend starts gets its own token each run, and only its own
  settings (never the OpenAI key).
- **Phones:** kept looks need HTTPS (`TLS_CERT_FILE`/`TLS_KEY_FILE` and an `https://` `PUBLIC_BASE_URL`).
- **Security audit:** see `reports/security-audit-2026-11-07.md`.
- **Before the event:** `npm run check` runs both test suites. `npm run soak -- 30` runs 30 minutes of
  visitor waves with injected image failures and fails if sessions or memory are not released.
  Measured: 300 visitors in 2 min, heap +1.1 MB, 0 sessions left. Rehearse the whole flow with the real
  camera and `npm run mock-openai` as well. CI (`.github/workflows/test.yml`) runs both suites and the
  npm and pip audits.

## Layout

```
src/
  server.js, app.js, config.js     entry, wiring (CORS, token, rate limits, timers, sidecar spawn), settings
  lib/mirror.js                    v2 orchestration: sessions, design rounds, renders, events
  lib/sidecar.js                   sidecar client, event subscription, process spawn
  lib/palette.js, colors.js        rule-based palettes, fit rules, colour distance and avoid matching
  lib/outfit-design.js             streamed structured design, colour enforcement, rule-based fallback
  lib/compose.js                   head paste and black background (sharp)
  lib/openai.js                    retries, timeouts, structured output, streaming, masks, budget check
  lib/budget.js, queue.js, metrics.js, events.js, looks.js, insights.js (ratings and corrections)
  lib/alerts.js, logfile.js        operator alerts (webhook), daily log files and log redaction
  lib/image-analysis.js, tryon.js, jobs.js, sessions.js, storage.js, catalogue.js   (v1)
  routes/mirror.js                 v2 routes
  routes/{style-me,review,suggestion,handheld,jobs}.js   v1 routes
test/                              node:test suites (mocked OpenAI and sidecar)
scripts/loadtest.mjs, soak.mjs, mock-openai.mjs   crowd burst, long-run soak, free rehearsal server
deploy/launchd.sh                  macOS supervisor (LaunchAgent)
dev/mirror.html, dashboard.html, style-me.html   mirror console, operations dashboard, v1 page
```

## API v1 (legacy, single photo, no sidecar needed)

These still work and are kept for the existing frontend.

| Route | Purpose |
|---|---|
| `POST /api/style-me` (+ `/:id/next`, `DELETE /:id`) | GPT photo check → skin measured from the photo → design → background try-on job |
| `GET /api/virtual-tryon/:jobId` | Poll a v1 try-on job |
| `POST /api/outfit-review` | Score and review the outfit the person is wearing |
| `POST /api/outfit-suggestion` | Pick from the predefined catalogue (needs `../wardrobe/` images, else 503) |
| `POST /api/handheld-virtual-tryon` | Render the person in the garment they're holding up |
| `GET /health` | Status, sidecar, budget, persistence |
