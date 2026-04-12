#!/bin/bash
# Volt IDE — clean rebuild with Tauri cache bust
set -e
cd "$(dirname "$0")"

pkill -f "target/release/app" 2>/dev/null || true
sleep 0.5

# Bust Tauri's WebKitGTK cache by rotating the identifier
CACHE_ID="com.volt.ide.v$(date +%s)"
sed -i "s/\"com\.volt\.ide[^\"]*\"/\"$CACHE_ID\"/" src-tauri/tauri.conf.json

rm -rf ~/.local/share/com.volt.* ~/.cache/com.volt.* 2>/dev/null
rm -rf ~/.local/share/webkitgtk/ ~/.cache/webkitgtk/ 2>/dev/null
rm -rf dist-frontend/ 2>/dev/null

# Don't delete src/dist/ — app.js lives there directly (no bundling)
# Just make sure the dir exists
mkdir -p src/dist
source $HOME/.cargo/env
cargo build --manifest-path src-tauri/Cargo.toml --release 2>&1 | tail -2

./src-tauri/target/release/app &
echo "Volt IDE launched ($CACHE_ID)"
