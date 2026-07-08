#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

if [ ! -f config/demo.env ]; then
  cp config/demo.env.example config/demo.env
  echo "Created config/demo.env from template. Review connect strings and passwords before starting."
fi

npm start
