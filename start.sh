#!/usr/bin/env bash
set -e

ROOT="$(cd "$(dirname "$0")" && pwd)"

FACE_PID=""
FACE_VENV="$ROOT/face-service/.venv"

echo "Starting Sentry backend on :8080…"
cd "$ROOT/backend"
go run . &
BACKEND_PID=$!

if [[ -x "$FACE_VENV/bin/python" ]]; then
  echo "Starting Sentry face-service on :8090…"
  cd "$ROOT/face-service"
  "$FACE_VENV/bin/python" -m face_service &
  FACE_PID=$!
else
  echo ""
  echo "  face-service venv not found — face recognition will be disabled."
  echo "  Run ./scripts/setup-face-service.sh once to install it."
  echo ""
fi

echo "Starting Sentry frontend on :5173…"
cd "$ROOT/frontend"
npm run dev -- --host 0.0.0.0 &
FRONTEND_PID=$!

echo ""
echo "  Backend     → http://localhost:8080"
if [[ -n "$FACE_PID" ]]; then
  echo "  Face-service → http://localhost:8090"
fi
echo "  Frontend    → http://localhost:5173"
echo ""
echo "Press Ctrl+C to stop."

cleanup() {
  trap - INT TERM
  kill "$BACKEND_PID" "$FRONTEND_PID" 2>/dev/null || true
  if [[ -n "$FACE_PID" ]]; then
    kill "$FACE_PID" 2>/dev/null || true
  fi
  exit 0
}
trap cleanup INT TERM
wait
