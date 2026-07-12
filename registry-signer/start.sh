#!/bin/bash
# Launch the Registry Signer, reusing volt-ide's already-installed Electron so
# there's nothing extra to download for dev.
cd "$(dirname "$0")"
ELEC="../volt-ide/node_modules/.bin/electron"
[ -x "$ELEC" ] || { echo "electron not found — run 'npm install' in ../volt-ide first (or 'npm i' here)"; exit 1; }
exec "$ELEC" . --no-sandbox "$@"
