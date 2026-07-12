#!/bin/bash
cd "$(dirname "$0")"

# Ensure a self-contained Python (with lark) is bundled for the compiler worker,
# mirroring the shipped app — so dev doesn't depend on a system Python having the
# right version + lark. First run downloads it (~40 MB, one-time); then it's cached.
PLATKEY="$(node -p 'process.platform+"-"+process.arch' 2>/dev/null)"
if [ -n "$PLATKEY" ] \
   && [ ! -x "sdk/python/$PLATKEY/bin/python3" ] \
   && [ ! -f "sdk/python/$PLATKEY/python.exe" ]; then
  echo "[start] bundling self-contained Python for $PLATKEY (one-time, ~40 MB)…"
  npm run bundle:python || echo "[start] bundle:python failed — falling back to system Python (needs >=3.10 + lark)"
fi

ELECTRON_DISABLE_SANDBOX=1 npx electron . "$@"
