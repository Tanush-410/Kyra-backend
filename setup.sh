#!/usr/bin/env bash
# One-command setup for the KYRA backend and camera sidecar. Safe to run again at any time.
#
#   ./setup.sh           install everything (Node packages, Python 3.12 environment, AI models, backend/.env,
#                        and the team's kiosk UI in Kyra-UI-V1/ when it is there)
#   ./setup.sh --check   only diagnose: what is installed, what is missing, and how to fix it
#
# Needs: Node 22+ and Python 3.12 (3.11 also works). If Python 3.12 is missing, the script uses `uv` to get
# it (uv downloads a private copy; nothing system-wide changes). macOS is the tested platform; Linux works the
# same way. On Windows use WSL.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
BACKEND="$ROOT/backend"
SIDECAR="$ROOT/sidecar"
UI="$ROOT/Kyra-UI-V1"
UI_REPO="https://github.com/minalkrishnadev-cpu/Kyra-UI-V1.git"
VENV="$SIDECAR/.venv"
MODELS="pose_landmarker_full.task face_landmarker.task gesture_recognizer.task face_detection_yunet_2023mar.onnx face_recognition_sface_2021dec.onnx"
CHECK_ONLY=0
[ "${1:-}" = "--check" ] && CHECK_ONLY=1

if [ -t 1 ]; then G=$'\033[32m'; Y=$'\033[33m'; R=$'\033[31m'; B=$'\033[1m'; N=$'\033[0m'; else G=; Y=; R=; B=; N=; fi
ok()   { printf '  %s✔%s %s\n' "$G" "$N" "$*"; }
warn() { printf '  %s!%s %s\n' "$Y" "$N" "$*"; WARNINGS=$((WARNINGS + 1)); }
bad()  { printf '  %s✘%s %s\n' "$R" "$N" "$*"; PROBLEMS=$((PROBLEMS + 1)); }
fix()  { printf '      → %s\n' "$*"; }
step() { printf '\n%s%s%s\n' "$B" "$*" "$N"; }
PROBLEMS=0
WARNINGS=0

find_uv() {
  for candidate in uv "$HOME/.local/bin/uv" "$HOME/.cargo/bin/uv" /opt/homebrew/bin/uv /usr/local/bin/uv; do
    if command -v "$candidate" >/dev/null 2>&1; then command -v "$candidate"; return 0; fi
  done
  return 1
}

python_version() { "$1" -c 'import sys; print("%d.%d" % sys.version_info[:2])' 2>/dev/null; }
python_ok() { case "$(python_version "$1")" in 3.12|3.11) return 0 ;; *) return 1 ;; esac; }

# A Python 3.12 (or 3.11) to build the environment from: installed ones first, then uv's.
find_python() {
  for candidate in python3.12 /opt/homebrew/bin/python3.12 /usr/local/bin/python3.12 python3.11 /opt/homebrew/bin/python3.11 python3; do
    if command -v "$candidate" >/dev/null 2>&1 && python_ok "$(command -v "$candidate")"; then command -v "$candidate"; return 0; fi
  done
  local uv
  if uv="$(find_uv)"; then
    local found
    found="$("$uv" python find 3.12 2>/dev/null)" && [ -n "$found" ] && { echo "$found"; return 0; }
    if [ "$CHECK_ONLY" = 0 ]; then
      "$uv" python install 3.12 >&2 && "$uv" python find 3.12 2>/dev/null && return 0
    fi
  fi
  return 1
}

# ---- Node ------------------------------------------------------------------------------------------
step "1. Node.js"
if ! command -v node >/dev/null 2>&1; then
  bad "Node.js is not installed"
  fix "Install Node 24 LTS from https://nodejs.org (or: brew install node@24), then run ./setup.sh again"
else
  NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
  if [ "$NODE_MAJOR" -lt 22 ]; then
    bad "Node $(node -v) is too old (need 22 or newer; 24 LTS recommended)"
    fix "Install Node 24 LTS from https://nodejs.org, or with nvm: nvm install 24"
  else
    ok "Node $(node -v)"
    if [ "$CHECK_ONLY" = 0 ]; then
      (cd "$BACKEND" && npm ci --no-audit --no-fund --loglevel=error) && ok "backend packages installed" || bad "npm ci failed (see the error above)"
    elif [ -d "$BACKEND/node_modules/fastify" ]; then
      ok "backend packages installed"
    else
      bad "backend packages are not installed"; fix "cd backend && npm ci"
    fi
  fi
fi

# ---- Python environment ---------------------------------------------------------------------------
step "2. Python environment for the camera sidecar (sidecar/.venv)"
if [ -x "$VENV/bin/python" ] && ! python_ok "$VENV/bin/python"; then
  if [ "$CHECK_ONLY" = 1 ]; then
    bad "sidecar/.venv uses Python $(python_version "$VENV/bin/python"); it must be 3.12 (the AI packages don't install on older versions)"
    fix "./setup.sh  (it sets aside the old environment and builds a new one)"
  else
    mv "$VENV" "$VENV.old-$(date +%Y%m%d%H%M%S)"
    warn "set aside an old sidecar/.venv built with the wrong Python; building a new one"
  fi
fi
if [ ! -x "$VENV/bin/python" ]; then
  if [ "$CHECK_ONLY" = 1 ]; then
    bad "sidecar/.venv does not exist"; fix "./setup.sh"
  elif PY="$(find_python)"; then
    "$PY" -m venv "$VENV" && ok "created sidecar/.venv with Python $(python_version "$PY")" || bad "could not create sidecar/.venv"
  else
    bad "Python 3.12 is not installed (macOS ships Python 3.9, which is too old for the AI packages)"
    fix "Easiest: install uv, which fetches Python 3.12 for this project only:"
    fix "  curl -LsSf https://astral.sh/uv/install.sh | sh    then open a new terminal and run ./setup.sh again"
    fix "Or install Python 3.12 yourself: brew install python@3.12 (or python.org), then run ./setup.sh again"
  fi
fi
if [ -x "$VENV/bin/python" ] && python_ok "$VENV/bin/python"; then
  if [ "$CHECK_ONLY" = 0 ]; then
    if "$VENV/bin/python" -m pip --version >/dev/null 2>&1; then
      "$VENV/bin/python" -m pip install -q --upgrade pip && "$VENV/bin/python" -m pip install -q -r "$SIDECAR/requirements.txt"
    elif UV="$(find_uv)"; then
      "$UV" pip install -q --python "$VENV/bin/python" -r "$SIDECAR/requirements.txt"   # uv-made environments have no pip
    else
      "$VENV/bin/python" -m ensurepip -q && "$VENV/bin/python" -m pip install -q -r "$SIDECAR/requirements.txt"
    fi
  fi
  if "$VENV/bin/python" -c 'import mediapipe, cv2, fastapi, numpy' 2>/dev/null; then
    ok "sidecar packages installed (Python $(python_version "$VENV/bin/python"))"
  else
    bad "sidecar packages are missing or broken"; fix "./setup.sh"
  fi
fi

# ---- Models -----------------------------------------------------------------------------------------
step "3. AI models (sidecar/models)"
if [ "$CHECK_ONLY" = 0 ]; then
  # The downloader needs only plain Python, so any python3 will do (models are fetched even if step 2 failed).
  DOWNLOADER="$VENV/bin/python"; [ -x "$DOWNLOADER" ] || DOWNLOADER="$(command -v python3 || true)"
  if [ -n "$DOWNLOADER" ]; then
    "$DOWNLOADER" "$SIDECAR/scripts/download_models.py" >/dev/null || bad "model download failed (check the internet connection, then run ./setup.sh again)"
  fi
fi
MISSING=""
for model in $MODELS; do [ -s "$SIDECAR/models/$model" ] || MISSING="$MISSING $model"; done
if [ -z "$MISSING" ]; then ok "all 5 models present"; else bad "missing:$MISSING"; fix "./setup.sh  (or: sidecar/.venv/bin/python sidecar/scripts/download_models.py)"; fi

# ---- Settings ---------------------------------------------------------------------------------------
step "4. Settings (backend/.env)"
if [ ! -f "$BACKEND/.env" ]; then
  if [ "$CHECK_ONLY" = 0 ]; then cp "$BACKEND/.env.example" "$BACKEND/.env" && ok "created backend/.env from .env.example"; else bad "backend/.env does not exist"; fix "cp backend/.env.example backend/.env"; fi
fi
if [ -f "$BACKEND/.env" ]; then
  KEY="$(grep -E '^OPENAI_API_KEY=' "$BACKEND/.env" | head -1 | cut -d= -f2- | tr -d '"'"'"' ')"
  if [ "$CHECK_ONLY" = 0 ] && { [ -z "$KEY" ] || [ "$KEY" = "your_openai_api_key_here" ]; } && [ -n "${OPENAI_API_KEY:-}" ]; then
    grep -v '^OPENAI_API_KEY=' "$BACKEND/.env" > "$BACKEND/.env.tmp" && printf 'OPENAI_API_KEY=%s\n' "$OPENAI_API_KEY" >> "$BACKEND/.env.tmp" && mv "$BACKEND/.env.tmp" "$BACKEND/.env"
    KEY="$OPENAI_API_KEY"; ok "wrote OPENAI_API_KEY from your shell into backend/.env"
  fi
  if [ -z "$KEY" ] || [ "$KEY" = "your_openai_api_key_here" ]; then
    warn "OPENAI_API_KEY is not set in backend/.env (outfits and images need it; 'npm run rehearse' works without it)"
    fix "edit backend/.env: OPENAI_API_KEY=sk-...   (or run: OPENAI_API_KEY=sk-... ./setup.sh)"
  else
    ok "OPENAI_API_KEY is set"
  fi
  chmod 600 "$BACKEND/.env" 2>/dev/null
fi

# ---- Kiosk UI ---------------------------------------------------------------------------------------
step "5. Kiosk UI (Kyra-UI-V1, served by the backend at /Kyra-UI-V1/)"
if [ ! -f "$UI/package.json" ]; then
  warn "Kyra-UI-V1/ is missing (the mirror screens, part of this repo; the backend's test console works without it)"
  fix "git checkout -- Kyra-UI-V1   (or clone $UI_REPO as Kyra-UI-V1/), then run ./setup.sh again"
elif [ "$CHECK_ONLY" = 0 ] && command -v npm >/dev/null 2>&1; then
  if (cd "$UI" && npm ci --no-audit --no-fund --loglevel=error && npm run build --silent >/dev/null); then
    ok "kiosk UI installed and built (Kyra-UI-V1/dist)"
  else
    bad "the kiosk UI did not build (see the error above)"; fix "cd Kyra-UI-V1 && npm ci && npm run build"
  fi
elif [ -f "$UI/dist/index.html" ]; then
  ok "kiosk UI is built (Kyra-UI-V1/dist)"
else
  bad "the kiosk UI is not built yet"; fix "cd Kyra-UI-V1 && npm ci && npm run build   (or ./setup.sh)"
fi

# ---- Running state ----------------------------------------------------------------------------------
step "6. Running state"
PORT="$(grep -E '^PORT=' "$BACKEND/.env" 2>/dev/null | head -1 | cut -d= -f2 | tr -d ' ')"; PORT="${PORT:-3000}"
if curl -s -o /dev/null --max-time 2 "http://localhost:$PORT/health"; then
  READY="$(curl -s --max-time 5 "http://localhost:$PORT/ready")"
  case "$READY" in
    *'"ready":true'*) ok "backend running on port $PORT and ready" ;;
    *sidecar_unavailable*) warn "backend running on port $PORT, camera sidecar not up yet: $READY"; fix "on first start it takes up to 30 s; if it stays, see 'Troubleshooting' in INTEGRATION.md" ;;
    *) warn "backend running on port $PORT, not ready: $READY" ;;
  esac
elif lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  bad "port $PORT is used by another program (not this backend)"
  fix "stop it, or set PORT=3100 (any free port) in backend/.env; the console follows automatically"
else
  ok "port $PORT is free (backend not running; start it with: cd backend && npm start)"
fi
if [ -f "$BACKEND/.runtime/secrets.json" ]; then ok "access tokens exist (cd backend && npm run links prints links with them)"; else ok "access tokens will be created on first start"; fi

# ---- Summary ----------------------------------------------------------------------------------------
printf '\n'
if [ "$PROBLEMS" -gt 0 ]; then
  printf '%s%d problem(s) to fix%s (see the → lines above), then run ./setup.sh again.\n' "$R" "$PROBLEMS" "$N"
  exit 1
fi
printf '%sReady.%s Next:\n' "$G" "$N"
printf '  cd backend && npm start        start the backend and camera (first start: allow camera access; wait ~30 s)\n'
printf '  cd backend && npm run links    links to the kiosk UI, console and dashboard, tokens included\n'
printf '  cd backend && npm run rehearse free run with a fake OpenAI (no key, no cost)\n'
[ "$WARNINGS" -gt 0 ] && printf '%s%d warning(s) above.%s\n' "$Y" "$WARNINGS" "$N"
exit 0
