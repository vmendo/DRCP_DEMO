#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PID_FILE="$ROOT_DIR/logs/server.pid"
LOG_FILE="$ROOT_DIR/logs/server.log"
PORT="${PORT:-8080}"
BACKGROUND=false
MODE="${BENCHMARK_MODE:-traditional}"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --background)
      BACKGROUND=true
      ;;
    --mode)
      shift
      MODE="${1:-}"
      ;;
    DRCP|drcp)
      MODE="drcp"
      ;;
    TRADITIONAL|traditional)
      MODE="traditional"
      ;;
    *)
      echo "Unknown option: $1"
      echo "Usage: ./run.sh [DRCP|TRADITIONAL] [--mode traditional|drcp] [--background]"
      exit 1
      ;;
  esac
  shift
done

case "${MODE,,}" in
  drcp|pooled) MODE="drcp" ;;
  traditional|dedicated) MODE="traditional" ;;
  *) echo "Invalid mode: $MODE. Use traditional or drcp."; exit 1 ;;
esac

export BENCHMARK_MODE="$MODE"
export PORT

cd "$ROOT_DIR"
mkdir -p "$ROOT_DIR/logs"

if [ ! -f "$ROOT_DIR/config/demo.env" ]; then
  cp "$ROOT_DIR/config/demo.env.example" "$ROOT_DIR/config/demo.env"
  echo "Created config/demo.env from config/demo.env.example"
fi

if [ ! -d "$ROOT_DIR/node_modules" ]; then
  echo "Installing Node dependencies..."
  npm install
fi

if [ -f "$PID_FILE" ]; then
  old_pid="$(cat "$PID_FILE" 2>/dev/null || true)"
  if [ -n "$old_pid" ] && kill -0 "$old_pid" 2>/dev/null; then
    if ps -p "$old_pid" -o args= | grep -q "backend/src/server.js"; then
      echo "Stopping existing DRCP demo server PID $old_pid"
      kill "$old_pid"
      for _ in $(seq 1 20); do
        kill -0 "$old_pid" 2>/dev/null || break
        sleep 0.5
      done
    else
      echo "PID file points to a non-demo process; refusing to stop it: $old_pid"
      exit 1
    fi
  fi
  rm -f "$PID_FILE"
fi

echo "Starting DRCP demo on http://localhost:$PORT in ${MODE^^} mode"

if [ "$BACKGROUND" != true ]; then
  echo "Foreground mode. Keep this terminal open; press Ctrl-C to stop."
  exec node backend/src/server.js
fi

nohup node backend/src/server.js > "$LOG_FILE" 2>&1 &
server_pid="$!"
echo "$server_pid" > "$PID_FILE"

for _ in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:$PORT/api/runtime/configuration" >/dev/null 2>&1; then
    echo "DRCP demo is running"
    echo "URL: http://localhost:$PORT"
    echo "Mode: ${MODE^^}"
    echo "PID: $server_pid"
    echo "Log: $LOG_FILE"
    exit 0
  fi
  if ! kill -0 "$server_pid" 2>/dev/null; then
    echo "DRCP demo failed to start. Last log lines:"
    tail -n 80 "$LOG_FILE" || true
    exit 1
  fi
  sleep 1
done

echo "Server process started but health check timed out. Last log lines:"
tail -n 80 "$LOG_FILE" || true
exit 1
