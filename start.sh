#!/bin/sh
set -e

echo "[start.sh] PWD: $(pwd)"
echo "[start.sh] Python: $(python --version 2>&1)"
echo "[start.sh] Files: $(ls)"

exec python -u run.py
