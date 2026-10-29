#!/bin/sh
# Build Volt IDE for every platform and publish to dl.voltembedded.com/ide
# (R2 bucket volt-dl), where installed IDEs look for updates (src/main/updater.js).
#   scripts/release-ide.sh 0.2.0          build, upload, then move latest*.yml
#   scripts/release-ide.sh 0.2.0 --dry    build only
# Run on macOS (the mac builds and the bundled darwin volt need it). macOS
# auto-update only works for a signed app: set CSC_LINK / CSC_KEY_PASSWORD
# (and APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID to notarize).
set -eu

VERSION=${1:?usage: release-ide.sh X.Y.Z [--dry]}
VERSION=${VERSION#v}
DRY=${2:-}
BUCKET=volt-dl
IDE=$(cd "$(dirname "$0")/.." && pwd)
WEB="$IDE/../../web"
cd "$IDE"

# A Developer ID identity in the login keychain signs too; CSC_LINK is for CI.
if [ -z "${CSC_LINK:-}" ] && ! security find-identity -v -p codesigning | grep -q "Developer ID Application"; then
	echo "warning: no Developer ID identity — the macOS build is unsigned and can't auto-update" >&2
fi
# Without notarization, Gatekeeper blocks the downloaded app on first launch.
if [ "$DRY" != --dry ] && [ -z "${APPLE_KEYCHAIN_PROFILE:-}${APPLE_ID:-}${APPLE_API_KEY:-}" ]; then
	echo "error: set APPLE_KEYCHAIN_PROFILE (xcrun notarytool store-credentials) to notarize" >&2
	exit 1
fi

npm version "$VERSION" --no-git-tag-version --allow-same-version >/dev/null
rm -rf dist
npm run prepack
npm run build:volt -- darwin-arm64 darwin-x64 linux-x64 win32-x64
npx electron-builder --mac --linux --win --publish never

[ "$DRY" = --dry ] && { echo "dry run: $IDE/dist"; exit 0; }

cd "$WEB"
# Installers and block maps first, the latest*.yml feeds last, so an IDE never
# sees a version whose files are not there yet.
for f in "$IDE"/dist/*.dmg "$IDE"/dist/*.zip "$IDE"/dist/*.exe "$IDE"/dist/*.AppImage "$IDE"/dist/*.deb "$IDE"/dist/*.blockmap; do
	[ -f "$f" ] || continue
	npx wrangler r2 object put "$BUCKET/ide/$(basename "$f")" --file "$f" --remote
done
for f in "$IDE"/dist/latest*.yml; do
	npx wrangler r2 object put "$BUCKET/ide/$(basename "$f")" --file "$f" \
		--content-type text/yaml --cache-control "max-age=60" --remote
done
echo "published Volt IDE $VERSION"
