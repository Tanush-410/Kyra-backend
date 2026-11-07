# KYRA smart mirror: backend and perception sidecar

A visitor stands in front of the mirror and picks a style. The camera measures their skin tone, height and
build. The backend designs three outfits in colours that suit them, and shows them wearing the first one, with
their real face kept.

| Start here | For |
|---|---|
| [INTEGRATION.md](INTEGRATION.md) | Connecting this repo to the team's frontend (Tauri app) and existing backend |
| [backend/README.md](backend/README.md) | The API (v2 mirror flow and the old v1 endpoints), settings, pipeline details, operations |
| [sidecar/README.md](sidecar/README.md) | Camera, skin tone and lighting, height calibration, sidecar API |

Quick start on the mirror machine (macOS, Node 24, Python 3.12):

```bash
cd backend && cp .env.example .env && npm install       # set OPENAI_API_KEY in .env
cd ../sidecar && python3.12 -m venv .venv && .venv/bin/pip install -r requirements.txt \
  && .venv/bin/python scripts/download_models.py
cd ../backend && npm start                               # starts the camera sidecar too
```

Tests: `cd backend && npm run check` runs both suites.
