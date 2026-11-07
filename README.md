# KYRA smart mirror: backend and perception sidecar

A visitor stands in front of the mirror and picks a style. The camera measures their skin tone, height and
build. The backend designs three outfits in colours that suit them, and shows them wearing the first one, with
their real face kept.

| Start here | For |
|---|---|
| [INTEGRATION.md](INTEGRATION.md) | Connecting this repo to the team's frontend (Tauri app) and existing backend |
| [backend/README.md](backend/README.md) | The API (v2 mirror flow and the old v1 endpoints), settings, pipeline details, operations |
| [sidecar/README.md](sidecar/README.md) | Camera, skin tone and lighting, height calibration, sidecar API |

Quick start (macOS or Linux, Node 22+; the script gets Python 3.12 for you):

```bash
./setup.sh                    # installs everything; says exactly what to do if something is missing
cd backend && npm start       # or: npm run rehearse (fake OpenAI, free, no key needed)
cd backend && npm run links   # in a second terminal: console and dashboard links, tokens included
```

Put your OpenAI key in `backend/.env` first (or run `OPENAI_API_KEY=sk-... ./setup.sh`). If anything goes wrong,
run `./setup.sh --check` and see [Troubleshooting](INTEGRATION.md#10-troubleshooting).

Tests: `cd backend && npm run check` runs both suites.
