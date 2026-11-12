# KYRA Mirror: Onboarding (React)

The kiosk screens for the KYRA mirror (1080 × 3840 portrait), connected to the KYRA backend
([Kyra-backend](https://github.com/Tanush-410/Kyra-backend)), which owns the camera, measures the visitor and
designs and renders their looks.

Needs Node 22 or newer.

## Run

**On the mirror (and the easiest way to try it):** the backend serves this app. This UI is included in
Kyra-backend as `Kyra-UI-V1/`, so one clone has everything.

```bash
# in Kyra-backend/
./setup.sh                  # installs everything, including `npm ci && npm run build` here
cd backend && npm start     # or `npm run rehearse`: a fake OpenAI, free
npm run links               # open the "Kiosk UI" link: http://localhost:3000/Kyra-UI-V1/#token=…
```

After changing the UI, `npm run build` here and reload the page. The backend doesn't need a restart.

**While developing screens:** hot reload, with the API forwarded to the backend.

```bash
npm install
npm run dev                 # http://localhost:5173/Kyra-UI-V1/  (the backend must be running)
```

Open it once with the token, `http://localhost:5173/Kyra-UI-V1/#token=<apiToken>`. The apiToken is in
`Kyra-backend/backend/.runtime/secrets.json`, and `npm run links` prints it. Or put `VITE_KYRA_TOKEN=` in
`.env.local`. See `.env.example` for all settings.

**Tests:** `npm test` (Node's built-in runner, no extra packages).

## How it talks to the backend

| Piece | File | What it does |
|---|---|---|
| Settings | `src/config.js` | API address (same origin by default), camera source, the kiosk token (from the link's `#token=`, then kept in localStorage). |
| API client | `src/api/kyraClient.js` | Every `/api/v2` call, and the event stream (`EventSource`). |
| Visit state | `src/context/KyraSessionContext.jsx` | One event stream for the app, reopened for the visitor's session so their images arrive. Actions: `start`, `showAnother`, `like`, `keep`, `confirmProfile`, `correctUndertone`, `end`. |
| Reducer | `src/state/sessionReducer.js` | Pure: builds the visit from events and snapshots. Every case is tested in `sessionReducer.test.js`. |
| Choices → request | `src/lib/visitIntent.js` | `?category=tops-female&q=…` becomes `{ style: "…, built around a top", gender: "female" }`. |
| Camera | `src/context/CameraContext.jsx`, `src/lib/mjpegStream.js` | The backend's camera preview becomes the app's video, so hand tracking and the camera screens work as before. |
| Guidance copy | `src/lib/guidanceCopy.js` | The camera's states (`too_close`, `move_left`, `ready`…) mapped to the screen text. |

### The visit

1. **Splash:** a wave (the shared hand detector, `useWaveDetector`) or a click starts. Returning here ends any
   previous visit.
2. **Onboarding picks**, unchanged.
3. **Analysis intro**, then **Consent** (`ConsentScreen`, Figma "Concnt"): the photo goes to OpenAI, so the
   backend won't start a visit without consent. "Continue" starts the session. The QR code opens the privacy
   page (the backend's `PRIVACY_URL`, or its own `/privacy`); it is left out when phones couldn't open it
   (neither `PRIVACY_URL` nor `PUBLIC_BASE_URL` set).
4. **Hold still:** the live camera with the backend's guidance (red brackets), then "Great, hold still!"
   (green), then the 3, 2, 1 on its own, timed by the backend's hold time. When the camera captures: a white
   flash, "All set! Let's find your perfect fit" for 2 s, then on (`src/lib/captureSequence.js`). There is
   no "multiple people" message: the backend follows the nearest person.
5. **Skin Tone Analysis** (`screens/results/SkinToneScreen`, Figma "Colour Result"): undertone, depth and
   clarity chips, and five colours with a role each (Core, Supporting, Accent; worked out from the palette in
   `src/lib/colourRoles.js`, as the backend sends neither). "Know more" explains the undertone and lets the
   visitor correct it; an unsure reading asks "Does this sound like you?" first.
6. **Fit Analysis** (`screens/results/FitAnalysisScreen`, Figma "Fit analysis" and "Guide"): the silhouette
   (the design's woman's figure for female visitors, its outlines only otherwise), a first-time guide, the
   outlines explaining what the camera measured (build, height), and styling levers for four goals
   (`src/lib/fitLevers.js`; the first goal follows the profile).
7. **Suggestions** (`screens/results/SuggestionsScreen`, Figma "Suggestion to buy"): the round's outfits,
   one at a time, each piece as a card with its colour swatch (the backend has no product photos). Swipe
   (drag), the arrows or the keyboard switch outfits; a first-time hint shows how. Tapping the outfit opens
   Virtual try-on (renders it on the visitor; a look already rendered is reused, at no cost) and More like
   this (the backend designs a new round from it and renders its first look).
8. **The look** (`LookResultScreen`): the look on the visitor, and Love it / Show another / Take it home
   (a QR code) / I'm done. It renders in the background from the moment of the photo: both analysis screens
   say how it is going and can skip straight to it. Leaving the mirror, or "I'm done", ends the visit and the
   photo is forgotten.

### Camera source

- `VITE_CAMERA_SOURCE=backend` (default): the backend's camera does everything. The UI never opens the webcam,
  so two programs never fight over it (Windows allows only one). The preview is already mirrored.
- `VITE_CAMERA_SOURCE=browser`: this browser's webcam, with the pose check in `useBodyScan`. The photo is
  uploaded when the countdown ends. Use it when the UI runs on a different machine from the camera.

## Notes for the team

- **No secrets in the build.** The token arrives in the link's `#` part, which browsers don't send to servers.
- **Content Security Policy:** when served by the backend, scripts may only come from this app. MediaPipe's
  attempts to send usage logs to Google are blocked (you'll see that in the console). Hand tracking is
  unaffected.
- **Models are local:** `public/mediapipe/` holds the hand and pose models and the WASM files (from
  `npm run assets`). The splash screen no longer downloads a second copy from a CDN.
- **Shop demo** (`VITE_SHOP_DEMO=true`, off by default): the friend's products, cart, filter, checkout and
  piece edits, and the cart and filter buttons in the header. Their prices, sizes, brands and stock are
  placeholders (`src/data/shopPlaceholders.js`), so real visitors never see them unless it is turned on.
- **Design checks:** `npm run dev`, then `/Kyra-UI-V1/dev/<name>` shows a piece or screen on its own (header,
  toast, dialog, consent, too-far, hold, count, flash, allset…; the list is in `src/dev/ComponentPreview.jsx`).
  These pages are left out of the production build. The team's Figma exports go in `design/` (git ignores it).
- **`OptionCard` has a `disabled` prop.** A pinch skips disabled buttons and anything behind an open dialog
  (`inert`).
- **Routes are unchanged**, plus `…/analysis/consent`. The results route is still `…/holdstill/analysisres`.
- `npm run deploy` (GitHub Pages) still works for showing the screens, but there's no backend there.
