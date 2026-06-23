#!/bin/sh
set -e

echo "[start.sh] PWD: $(pwd)"
echo "[start.sh] Node: $(node --version 2>&1)"
echo "[start.sh] Files: $(ls)"

exec node web/server.js
