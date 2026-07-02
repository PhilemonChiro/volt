#!/bin/bash
# Launch the IDE over a remote/SSH session (e.g. via Tailscale).
#
# Chromium's zygote does namespace/shared-memory setup that fails when Electron is
# spawned from a detached SSH session (renderer crashes with a /dev/shm "No such
# process" error and the window stays blank). --no-zygote spawns renderers directly
# and --disable-gpu avoids the GPU process, so the UI renders in that context.
#
# For a normal launch on the machine's own desktop, use ./start.sh instead — those
# flags are not needed there.
cd "$(dirname "$0")"
ELECTRON_DISABLE_SANDBOX=1 exec npx electron . --no-zygote --disable-gpu "$@"
