#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PID_FILE="$ROOT_DIR/logs/server.pid"

if [ ! -f "$PID_FILE" ]; then
  echo "No DRCP demo PID file found at $PID_FILE"
  exit 0
fi

pid="$(cat "$PID_FILE" 2>/dev/null || true)"
if [ -z "$pid" ]; then
  rm -f "$PID_FILE"
  echo "Removed empty PID file"
  exit 0
fi

if ! kill -0 "$pid" 2>/dev/null; then
  rm -f "$PID_FILE"
  echo "DRCP demo process is not running"
  exit 0
fi

if ! ps -p "$pid" -o args= | grep -q "backend/src/server.js"; then
  echo "PID $pid is not the DRCP demo server; refusing to stop it"
  exit 1
fi

kill "$pid"
rm -f "$PID_FILE"
echo "Stopped DRCP demo server PID $pid"
