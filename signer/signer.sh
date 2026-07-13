#!/bin/bash
# Launch the Volt Registry Signer. Reuses the IDE's Electron binary so this app
# needs no node_modules / Electron download of its own.
cd "$(dirname "$0")"
ELECTRON="../volt-ide/node_modules/.bin/electron"
if [ ! -x "$ELECTRON" ]; then
  echo "Electron not found at $ELECTRON — run 'npm install' in ../volt-ide first."
  exit 1
fi
ELECTRON_DISABLE_SANDBOX=1 "$ELECTRON" . "$@"
