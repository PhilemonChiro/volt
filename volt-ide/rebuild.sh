#!/bin/bash
# Volt IDE — clean rebuild with cache clear
set -e

# Kill running instance
pkill -f "target/release/app" 2>/dev/null || true

# Clear ALL caches
rm -rf ~/.local/share/com.volt.ide/ 2>/dev/null
rm -rf ~/.cache/com.volt.ide/ 2>/dev/null
rm -rf ~/.config/com.volt.ide/ 2>/dev/null
rm -rf ~/.local/share/webkitgtk/ 2>/dev/null
rm -rf ~/.cache/webkitgtk/ 2>/dev/null

# Clean build
rm -f src/dist/app.js
npm run build

# Rebuild Rust
source $HOME/.cargo/env
cargo build --manifest-path src-tauri/Cargo.toml --release 2>&1 | tail -2

# Launch
./src-tauri/target/release/app &
echo "Volt IDE launched (caches cleared)"
