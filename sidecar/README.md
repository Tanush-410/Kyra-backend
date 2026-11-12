# KYRA perception sidecar

A local Python service that runs the mirror's camera and all on-device perception. Nothing it does costs
money or leaves the machine. The Node backend is its only client.

- **Live guidance:** pose landmarks decide one instruction at a time: "step back", "one person at a time",
  "hold still", and so on.
- **Auto-capture:** when the backend arms it, it captures the sharpest frame once the visitor has held a
  ready pose for `READY_HOLD_MS`.
- **Skin tone:** measured by the vendored undertone detector (`kyra_sidecar/vendor/undertone`, see
  `VENDORED.md` there) through `undertone_adapter.py`. The face mesh gives four regions (forehead, both
  cheeks, chin). The room's light is removed from each frame first (see **Lighting** below). Shine
  (bright, colourless highlights) is dropped from each region. The detector then measures CIELAB per region, rejects outlier
  regions, compensates for flushed cheeks, and runs a quality gate (exposure, uneven light or colour,
  too few skin pixels). Frames over a visit (up to `SKIN_FRAMES`, every other camera frame) are combined.
  The result is a continuous warm-to-cool score with a 95% interval and a stable/olive flag, plus ITA°
  for depth, the measured skin colour as a swatch (`skinHex`), the detector's statement ("Your undertone is
  WARM (Warm Undertone)") and its styling advice (flattering colour families, best metals, colours to go
  easy on). Olive needs a clear green-yellow offset (b* − 1.25·a* ≥ 9); olive skin gets the olive palette
  in the backend. Hair over the forehead and beard on the chin are dropped from the sample (pixels much
  darker than the cheeks). Confidence is `high` only with a grey card and five clean frames. Otherwise the mirror asks
  "looks right?", and a `low` reading falls back to the neutral palette. `UNDERTONE_ENGINE=legacy`
  switches back to the original single-patch measurement.
- **Lighting** (`lighting.py`): the light's colour and strength are worked out and removed before skin is
  measured, so the same person reads the same under warm bulbs, cool LEDs or daylight, and whether the camera
  exposed brighter or darker. Cues, most trusted first:
  1. **Grey card** (if calibrated), read live in every frame. It also normalises exposure, to the card's
     printed L* if `cardLightness` was given, otherwise to its brightness at calibration time.
  2. **Room model** (live camera): the empty room is learned while nobody is in frame. With a visitor in
     frame, the visible background is compared with it, which measures exactly how much the light and the
     camera's white balance and exposure have changed, whatever colour the walls are. Its baseline (the
     empty room's own light) starts from background statistics and is refined from visitors' eye whites, so a
     beige or coloured wall stops biasing it after a few visits. Rearranging the room is detected and it is
     relearned. The model lives in memory and is relearned on restart.
  3. **Background statistics**, with every person excluded: gray-world, shades-of-gray, gray-edge and
     brightest pixels, combined by median and pulled toward real light colours (the black-body locus).
  4. **Eye whites** (sclera): in the same light as the skin, checked to be brighter and much less red than
     the cheeks. They need a reasonably large, open eye, so they help most while the visitor walks up.
     A statistical cue that disagrees strongly with the eyes loses its weight.
  The correction is smoothed over a visit. Each reading reports `lighting` (method, detected cast such as
  "warm (yellow-orange) light", exposure correction, confidence). Frames where the light was measured
  well are preferred. If it was a guess for the whole visit, `lightingUncertain` is set and a hint is added.
- **Several people in view:** the nearest person is the subject: the largest apparent body (shoulder width,
  torso or head, whichever is least foreshortened), preferring someone facing the mirror and near the
  centre. The subject is tracked from frame to frame. Someone else takes over only when clearly nearer
  (25%) for 5 frames in a row, or after the subject has been gone for 4 frames. When the subject changes, their
  skin samples, face close-up and lighting estimate are dropped (never mixed between people) and a
  `subject` event is sent. The face mesh runs on the subject only, and when a neighbour's face is also in
  the head crop, the face on the subject's own nose is used. Everyone's masks are kept out of the light estimates.
- **Height:** head-to-heel height in the frame, converted to centimetres by a calibration fitted from
  reference people (see below). Without calibration, height is reported as unknown, never guessed.
- **Build:** shoulder width relative to body length, from metric world landmarks. Reported only for
  someone standing.
- **Masks:** person and head masks, and a 1024×1536 cut-out of the visitor on black, ready to render. The
  cut-out uses an edge-aware matte (guided filter), so hair edges are clean and the room doesn't leave a halo.
- **Finishing renders (`/compose`):** warps the render onto the capture's body landmarks, then pastes the
  visitor's real head back (and, with `COMPOSE_HANDS=true`, each hand that lines up). It blacks out the background
  with a feathered matte and checks identity with SFace, all in one call (~0.3 s).
- **Identity:** a 128-d SFace face embedding (OpenCV Zoo) for the backend's face check.
- **Gestures:** thumbs up, thumbs down, victory and so on (MediaPipe gesture recognizer), held 0.6 s, with a 2 s cooldown.
- **Presence:** reports when the visitor has left, so the backend can forget them.
- **Watchdog:** reopens the camera with backoff if it won't open, stops delivering frames, or freezes.
- **Steady guidance:** an instruction changes only after the new state has held for 3 frames, so the
  visitor doesn't see flicker and a one-frame blip doesn't reset the capture countdown. "Step a little
  closer" appears only when the visitor fills under half the frame height. Face size never changes the
  instruction, because on a landscape camera a head-to-toe framing leaves the face about 80 px wide.
- **Clearest face of the visit** (`facetransfer.py`): every frame's face is scored on size, sharpness,
  facing the mirror, eyes open and light; the best is kept at 512×512 and goes with the capture. `/compose`
  places it onto the render's face (lined up with the face mesh, colour-matched, blended inside the face only)
  when the faces line up and the identity check improves. A clearly better face after the capture is announced
  (`face` event) so a finished look can be updated through `/face/transfer`.
- **Silhouette matching** (`silhouette.py`, used by `/compose` when `COMPOSE_SILHOUETTE=true`; off by default
  because it squeezed loose garments on webcam captures): makes the render's body outline the visitor's own,
  from the neck to the ankles.

## Setup

```bash
./setup.sh                           # from the repo root: Python 3.12 environment, packages, models
sidecar/.venv/bin/python -m kyra_sidecar   # only to run the sidecar on its own: http://127.0.0.1:8765
```

Needs Python 3.12 (3.11 works); macOS's built-in 3.9 is too old for the AI packages. `setup.sh` finds a
suitable Python or gets one with `uv`. Building it by hand: `uv venv --python 3.12 sidecar/.venv`, then
`uv pip install --python sidecar/.venv/bin/python -r sidecar/requirements.txt` (a `uv` environment has no
`pip`), then `sidecar/.venv/bin/python sidecar/scripts/download_models.py`.

When `sidecar/.venv` exists, the backend starts the sidecar itself (`SIDECAR_SPAWN=auto`). On macOS, the
app that launches it (Terminal, VS Code or the Tauri app) needs camera permission.

## Settings (environment)

| Variable | Default | Meaning |
|---|---|---|
| `SIDECAR_HOST` / `SIDECAR_PORT` | `127.0.0.1` / `8765` | Listen address. Keep it on localhost. |
| `SIDECAR_TOKEN` | — | If set, requests need an `x-sidecar-token` header. The backend generates one for a sidecar it starts; set the same value in both if you start the sidecar yourself. |
| `SIDECAR_ALLOWED_HOSTS` | — | Host names requests may be addressed to besides localhost. Anything else gets `403` (stops DNS rebinding). |
| `SIDECAR_MAX_BODY_MB` | `32` | Larger request bodies are refused before they are read. Images over 40 megapixels (`OPENCV_IO_MAX_IMAGE_PIXELS`) are refused from their header, before decoding. |
| `CAMERA` | `true` | `false` disables the camera, leaving only the still-image endpoints. |
| `CAMERA_INDEX`, `CAMERA_WIDTH`, `CAMERA_HEIGHT` | `0`, `1920`, `1080` | Capture device and resolution. |
| `CAMERA_ROTATION` | `0` | Clockwise rotation (90, 180 or 270) for a camera mounted on its side or upside down. Don't work it out by eye: `npm run camera-check -- --apply` in `backend/` reads it from a face in view (`GET /camera/orientation`). |
| `CAMERA_MIRROR` | `true` | Flip frames horizontally, like a mirror. Left/right guidance follows this. |
| `ANALYSIS_WIDTH`, `TARGET_FPS` | `960`, `15` | Analysis resolution and frame rate. Captures use full resolution. |
| `READY_HOLD_MS` | `3000` | How long a ready pose must be held before auto-capture (the kiosk UI counts 3, 2, 1). |
| `SKIN_FRAMES` | `15` | Frames averaged for skin tone. |
| `ABSENT_AFTER_MS` | `30000` | How long nobody (no body and no face) can be in frame before the visitor counts as gone and the visit ends. 30 s matches the kiosk design's "Still here? We'll delete your session in 30 seconds." |
| `GESTURES`, `GESTURE_HOLD_MS`, `GESTURE_COOLDOWN_MS` | `true`, `600`, `2000` | Hands-free control. |
| `FREEZE_AFTER_S` | `5` | Byte-identical frames for this long count as a frozen camera, which is then reopened. |

## Calibration (once per installation)

Calibration is saved to `calibration.json`. You can also run it from the backend console
(`backend/dev/mirror.html`, Calibration section).

- **Height:** a person of known height stands on the visitor spot, head to toe in frame. Call
  `POST /calibrate/height {"heightCm": 178}`. One sample assumes a fixed spot. Two or more at different
  distances let the model correct for where people stand.
- **White balance:** place a matte neutral grey card in a fixed location that stays visible beside the
  visitor. Call `POST /calibrate/white-balance {"roi": {"x":0.45,"y":0.4,"width":0.1,"height":0.1}}`
  with its box as fractions of the camera frame. Add `"cardLightness": 50` (the card's printed L*; about 50
  for an 18% grey card) to make skin depth absolute. The ROI is saved, and live skin measurements read the
  card in each frame to track changing light. If the card is missing, too dark, or clipped, that frame
  is skipped instead of using a possibly misleading skin colour. Keep the card under the same light as
  the visitor and avoid glare or shadows across it.

## API

Requests that change something (any method but GET/HEAD/OPTIONS) need `x-sidecar-token` or an
`x-kyra-client` header; the backend always sends one. A web page can't add such a header without a CORS
preflight, which the sidecar never grants, so cross-site requests (for example a bodiless `POST /disarm`)
are refused. Every response carries `nosniff`, `no-referrer`, `DENY` framing and `no-store`.

| Endpoint | Purpose |
|---|---|
| `GET /health` | Camera status, armed session, calibration summary |
| `GET /state` | Latest guidance |
| `GET /events` | SSE events: `state`, `capture` (`captureId`), `presence`, `subject` (a different person became the subject), `gesture`, `camera` (incl. `reconnecting`), `armed` |
| `GET /preview.mjpg` | Live MJPEG preview (720 px wide). `?aspect=w/h&height=px`: the centre of the full-resolution frame in a screen's shape (the portrait kiosk), sharp instead of stretched |
| `POST /arm {sessionId}` / `POST /disarm` | Arm or disarm auto-capture for a session |
| `POST /capture` | Capture now (manual) |
| `GET` / `DELETE /captures/{id}` | Fetch or delete a capture bundle (deleted after 5 min regardless) |
| `POST /analyze {imageDataUrl}` | Same bundle from a still photo (uploads, tests) |
| `POST /segment {imageDataUrl}` | Person mask of any image |
| `GET /face/best` | The clearest face seen so far this visit (512×512 JPEG, score, quality details) |
| `POST /face/transfer {imageDataUrl, faceDataUrl}` | Places a close-up's face onto a finished look if safe: `{applied, imageDataUrl, report}` |
| `POST /face/compare {referenceDataUrl, imageDataUrl}` | SFace similarity plus face position shift and scale |
| `POST /compose {originalDataUrl, generatedDataUrl, keepMaskDataUrl}` | Align the render, paste the real head and hands, black background, identity check. Returns `headPasted`, `handsPasted`, `warp`, `similarity` |
| `GET` / `DELETE /calibration`, `POST /calibrate/height`, `POST /calibrate/white-balance` | Calibration |
| `POST /calibrate/undertone {samples: [{L, a, b, label}], save?}` | Fits the detector's warm/cool anchors (neutral hue, span, neutral band, depth slope) from labelled samples. With 15 or more samples, every fifth one is held out, and accuracy is reported for the fit and for the defaults. The fit is saved only with `save: true` |

## Tests

```bash
.venv/bin/python -m pytest -q tests
# Integration tests also need photos in one folder: fullbody.jpg (one person, head to toe),
# portrait.png (a different person, cropped above the knees), standing.png (a standing person)
# and render.png (a try-on render of standing.png):
KYRA_TEST_IMAGES=/path/to/photos .venv/bin/python -m pytest -q tests
```

## Heuristics to tune on site

- **Undertone anchors:** the detector defaults to neutral at 55° hue with a ±12° span. Fit them to the
  site's lights from visitors' confirmations: `npm run tune-thresholds` in the backend reports the fit,
  and `npm run tune-thresholds -- --save` applies it. The legacy thresholds in `color.py` (cool ≤ 50°,
  warm ≥ 58°) only matter with `UNDERTONE_ENGINE=legacy`.
- **Build thresholds** (`perception.py`, `body_frame`): slim < 0.24 and broad > 0.30 shoulder-to-length ratio.
- **Guidance thresholds** (`guidance.py`): brightness, centring, "too far", motion and sharpness.
