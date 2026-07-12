#!/usr/bin/env bash
# Stage toolchain tarballs + an UNSIGNED manifest ON THE VPS, so the ~600 MB of
# upstream downloads use the VPS's bandwidth (never your metered laptop) and the
# signing key stays off the server. Run this on the VPS; then sign the manifest
# locally (sign-manifest.js) and scp it back.
#
# Usage:
#   ./stage-on-vps.sh <path-to-volt-repo> <mirror-volume-_data-path> [tag]
#
# Find the mirror volume path once (Dokploy prefixes the project name):
#   docker volume ls | grep mirror-data
#   docker volume inspect <name> -f '{{.Mountpoint}}'
#
# Requires: docker (already present on a Dokploy host). No Node install needed —
# staging runs in a node container.
set -euo pipefail

REPO="${1:?usage: stage-on-vps.sh <volt-repo> <mirror-volume-_data-path> [tag]}"
VOLUME="${2:?missing mirror volume _data path}"
TAG="${3:-toolchains-2026.05}"

IDE_DIR="$REPO/volt-ide"
[ -f "$IDE_DIR/scripts/publish-toolchains.js" ] || { echo "no publish-toolchains.js under $IDE_DIR — is <volt-repo> correct?"; exit 1; }
[ -d "$VOLUME" ] || { echo "mirror volume path not found: $VOLUME"; exit 1; }

OUT="$(mktemp -d)"
echo "==> Downloading + hashing tarballs (VPS bandwidth) and writing UNSIGNED manifest…"
# publish-toolchains.js writes to /tmp/volt-mirror inside the container; mount our
# host OUT dir there. --stage-only skips GitHub; --allow-unsigned skips the key.
docker run --rm \
  -v "$IDE_DIR:/w" -w /w \
  -v "$OUT:/tmp/volt-mirror" \
  node:20-alpine \
  node scripts/publish-toolchains.js --stage-only --allow-unsigned

echo "==> Placing tarballs into the mirror volume: $VOLUME/$TAG/"
mkdir -p "$VOLUME/$TAG"
shopt -s nullglob
for f in "$OUT"/*.tar.xz "$OUT"/*.tar.gz "$OUT"/*.tgz "$OUT"/*.zip; do
  cp -f "$f" "$VOLUME/$TAG/"
  echo "    + $(basename "$f")"
done
chmod -R a+r "$VOLUME/$TAG"

echo ""
echo "==> Tarballs are live. The UNSIGNED manifest is at:"
echo "      $OUT/manifest.json"
echo ""
echo "Next (on your LAPTOP, where the signing key lives):"
echo "  1. scp  <this-vps>:$OUT/manifest.json  ./unsigned-manifest.json"
echo "  2. VOLT_TOOLCHAIN_SIGNING_KEY=~/.volt/secrets/volt-toolchain-signing.pem \\"
echo "       node volt-ide/deploy/toolchain-mirror/sign-manifest.js ./unsigned-manifest.json ./manifest.json"
echo "  3. scp  ./manifest.json  <this-vps>:$VOLUME/$TAG/manifest.json"
echo ""
echo "Until the signed manifest is uploaded, clients reject the (missing/unsigned)"
echo "remote manifest and safely fall back to the baked-in one → upstream tarballs."
