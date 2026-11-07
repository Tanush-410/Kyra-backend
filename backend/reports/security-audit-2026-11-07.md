# Security audit: KYRA mirror pipeline

7 November 2026. Scope: the Node backend (`backend/src`, dev consoles in `backend/dev`) and the Python
perception sidecar (`sidecar/kyra_sidecar`), with default settings from `.env.example`. Method: code review
of every route, auth path, file access and outbound call, plus live tests against the running code where
noted. **All ten findings were fixed the same day; see "Status after fixes" at the end.**

## Summary

| # | Severity | Finding |
|---|---|---|
| 1 | **High** | DNS rebinding: neither service checks the `Host` header, so a web page can reach both through the browser |
| 2 | Medium | API and sidecar tokens are off by default |
| 3 | Medium | Kept looks travel over plain HTTP on the venue network unless TLS is set up |
| 4 | Low | Sidecar `POST /capture` and `/disarm` can be triggered cross-site |
| 5 | Low | Sidecar has no request-size or image-pixel limit |
| 6 | Low | The spawned sidecar inherits the OpenAI key and all tokens |
| 7 | Low | The unfiltered event stream shows every visitor's images to any token holder |
| 8 | Low | No security headers on the share page or API responses |
| 9 | Low | Visitor text reaches the prompts (prompt injection, limited impact) |
| 10 | Info | Sidecar error text is passed through to API clients |

## Findings

### 1. High: DNS rebinding reaches the backend and the sidecar

Neither service checks the `Host` header. A web page opened in any browser on the mirror machine can
rebind its own domain to `127.0.0.1`. The browser then treats requests to `http://attacker.example:3000`
and `:8765` as same-origin, so CORS no longer applies.

**Evidence (tested live):**
```
backend GET /api/v2/metrics   Host: 127.0.0.1:3000          -> 200
backend GET /api/v2/metrics   Host: attacker.example:3000   -> 200
sidecar GET /calibration      Host: attacker.example:8765   -> 200
```

**Impact with default settings (no tokens):**
- Watch the live camera: `/preview.mjpg` on both services.
- Read the event stream, which carries every visitor's renders and measured profile.
- Fetch capture bundles.
- Start paid sessions, up to the daily spend cap.
- Reset or change calibration.

**Fix:** reject any request whose `Host` isn't `localhost`, `127.0.0.1` or `[::1]` (plus the `PUBLIC_BASE_URL`
host when set).
- Backend: an `onRequest` hook.
- Sidecar: Starlette's `TrustedHostMiddleware`.

Setting tokens (finding 2) also blocks this.

### 2. Medium: tokens are off by default

`API_TOKEN` and `SIDECAR_TOKEN` are empty in `.env.example`. With `HOST=127.0.0.1` the services are
local-only. But any process or user account on the machine, and any web page via finding 1, can use every
route, including operator ones.

**Fix:** generate both tokens on first start, if they're empty, and store them in `.runtime/`. The
backend already passes `SIDECAR_TOKEN` to a sidecar it spawns, and the kiosk page already accepts a token.

### 3. Medium: kept looks over plain HTTP

For phones to open the QR link, the backend has to listen on the venue network. Without
`TLS_CERT_FILE`/`TLS_KEY_FILE`, two things travel in clear text:
- the look (a photo of the visitor);
- its share token, which anyone on the same Wi-Fi can read.

**Fix:** refuse to keep looks when `PUBLIC_BASE_URL` isn't `https://`, or put the backend behind a
TLS-terminating proxy.

### 4. Low: cross-site triggering of sidecar `/capture` and `/disarm`

These take no body, so a cross-site `fetch(…, {method: 'POST', mode: 'no-cors'})` is a "simple" request:
it isn't preflighted, and it runs. Any web page could disarm the camera mid-visit or force a capture.
It can't read the result.

**Evidence:** by code inspection. These endpoints have no body and use the default empty token. The
sidecar's JSON endpoints are safe: a cross-site `text/plain` post was rejected with 422 (tested).

**Fix:** require the sidecar token (finding 2), or a custom header such as `x-kyra: 1`, which forces a preflight.

### 5. Low: no size or pixel limit in the sidecar

`/analyze`, `/segment`, `/face/compare` and `/compose` decode base64 images of any size
(`cv2.imdecode`, `capture.py:47`). OpenCV's own cap is about 1 billion pixels. A local caller can make the
sidecar allocate gigabytes. The backend's own limits (10 MB body, sharp's pixel limit) don't protect the
sidecar from other local callers.

**Fix:**
- Reject bodies over 15 MB.
- Check the image header and reject anything over 40 megapixels before decoding.

### 6. Low: the sidecar gets every secret

`maybeSpawnSidecar` starts Python with `env: { ...process.env }` (`backend/src/lib/sidecar.js`). That
includes `OPENAI_API_KEY`, `API_TOKEN` and `OPERATOR_TOKEN`, none of which the sidecar needs.

**Fix:** pass only the sidecar's own settings: `SIDECAR_*`, `CAMERA*`, `UNDERTONE_ENGINE`, `PATH`, `HOME`.

### 7. Low: the unfiltered event stream shows every visitor

`GET /api/v2/events` without `?sessionId` receives every session's events, including full render images.
Any holder of the kiosk token gets all of them: a second screen, a staff tablet.

**Fix:** require `sessionId` unless the client presents the operator token, or leave images out of the
unfiltered stream.

### 8. Low: no security headers

The `/looks/:token` page and the API send no `X-Content-Type-Options: nosniff`,
`Referrer-Policy: no-referrer`, `Content-Security-Policy` or `Cache-Control: no-store` on HTML. The share
token is in the URL. The page has no outside links today, but `no-referrer` would keep it from leaking if
one is added.

**Fix:** one `onSend` hook adding these headers.

### 9. Low: prompt injection from visitor text

`style` (≤120 characters), `feedback` (≤200) and the preference fields go into the design prompt. Its
answer is schema-checked and its colours are re-snapped to the palette. Item names, however, flow on into
the image prompt. A visitor could steer their own render toward odd content, within OpenAI's moderation.
It only affects that visitor's own session.

**Fix:** allow only letters, digits and basic punctuation in item names before they reach the image
prompt. Keep the length limits.

### 10. Info: sidecar error text reaches clients

`fail()` in `routes/mirror.js` returns `SidecarError` messages, such as "Sidecar unreachable: fetch failed".
This is harmless today, but internal detail shouldn't reach the visitor's screen.

**Fix:** map to a fixed message, as `mirror.js` now does for sessions.

## Checked and fine

- **Token checks:** constant-time comparison on both sides (`timingSafeEqual`, `hmac.compare_digest`).
- **Operator routes:** calibration, its reset and metrics are restricted when `OPERATOR_TOKEN` is set (added today).
- **Logs:** tokens and share links are redacted from request logs (added today).
- **Secrets:** `.env` is owner-only (`-rwx------`) and ignored by `.gitignore`.
- **Network exposure:** `HOST` defaults to `127.0.0.1`, with a startup warning when the backend is exposed
  without a token.
- **Cross-site requests:** CORS is limited to localhost and Tauri. JSON-only body parsing blocks
  cross-site form posts to JSON routes.
- **Abuse limits:** rate limits, a daily spend cap, and consent before capture.
- **Visitor data:** photos are kept in memory only and dropped when the visitor leaves. Kept looks use
  128-bit random tokens, validated by regex (no path traversal), and expire.
- **Uploads:** 10 MB body limit, sharp's pixel limit, and a free local quality check before any paid call.
- **XSS:** the dev consoles escape all model output; none found.
- **Outbound calls:** the OpenAI, sidecar and webhook URLs come only from the environment (no SSRF).
- **Dependencies:** `npm audit` finds 0 known vulnerabilities, including the new `gpt-tokenizer` dev dependency.

## Not covered

- **Python dependency vulnerabilities:** `pip-audit` isn't installed here. It runs in CI
  (`.github/workflows/test.yml`).
- **The Tauri app:** `src-tauri/` isn't in this folder.
- **The OpenAI account:** use a project-scoped key with a hard monthly limit, so a leaked key has a ceiling.

## Status after fixes (7 November 2026)

All ten findings are fixed. Each fix is covered by an automated test. The last column says how each was
checked on the real backend and sidecar processes (sidecar started by the backend, camera off).

| # | Fix | Test | Checked live |
|---|---|---|---|
| 1 | Host allowlist on both services (`hostName`/`allowedHostNames` in `app.js`; `RequestGuard` in the sidecar). Extra names: `ALLOWED_HOSTS`, `SIDECAR_ALLOWED_HOSTS` | backend `production.test.js`, sidecar `test_security.py` | `Host: attacker.example` gets 403 from both |
| 2 | Tokens on by default: `API_TOKEN` and `OPERATOR_TOKEN` generated on first start into `.runtime/secrets.json` (mode 600), never logged; `off` disables one. A sidecar the backend starts gets a fresh token each run | `production.test.js` | file mode 600; API without token 401; metrics with the kiosk token 401, with the operator token 200; sidecar without token 401; 0 tokens in the logs |
| 3 | Keeping looks is refused when `PUBLIC_BASE_URL` is plain `http://` on a network address (`ALLOW_INSECURE_LOOKS=true` overrides) | `production.test.js` | — |
| 4 | Sidecar refuses state-changing requests without `x-sidecar-token` or `x-kyra-client`; the backend always sends one | `test_security.py` | bodiless `POST /disarm` gets 403 |
| 5 | Sidecar refuses bodies over `SIDECAR_MAX_BODY_MB` (32), unsized streamed bodies, and images over 40 MP, read from the PNG/JPEG/WebP header before decoding (OpenCV's own limit as a second layer) | `test_security.py` (a 70 KB, 64-megapixel PNG is refused) | — |
| 6 | The spawned sidecar gets only its own settings (`sidecarEnv`) | `production.test.js` | the sidecar's environment has no `OPENAI_API_KEY` |
| 7 | Without `?sessionId=`, session events arrive with images and links set to `null`; the operator token, or `EVENT_STREAM_IMAGES=all`, sees everything. `dev/mirror.html` reopens its stream scoped to its session and fills gaps from the snapshot | `production.test.js`; two older tests updated to the new rule | — |
| 8 | `nosniff`, `no-referrer`, `DENY` framing and `no-store` on every response from both services; strict content policy on the share page | backend and sidecar tests | headers present on `/health` |
| 9 | `promptText` cleans visitor text (style, feedback, preferences) and model-written item names before any prompt: one line, no quotes, colons, brackets, markup, control or invisible characters; hex colours validated | `production.test.js` | — |
| 10 | Visitors see a plain message for sidecar errors; operators calibrating still get the sidecar's reason | `production.test.js` | — |

**Test totals after the fixes:** backend 101 passed, sidecar 124 passed (15 skipped: they need test photos).

**Compatibility to check:** the Tauri frontend (not in this folder) must now send the kiosk token, and should
pass `?sessionId=` on its event stream once it starts a session. Until it does, set `EVENT_STREAM_IMAGES=all`;
`API_TOKEN=off` is a last resort.

**Still open:** a Python dependency audit (runs in CI) and a review of the Tauri app.
