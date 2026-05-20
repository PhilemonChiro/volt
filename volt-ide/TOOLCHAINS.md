# Volt IDE Toolchain Mirror

The IDE downloads chip toolchains (ARM GCC, cmake, ninja, ...) on first use
rather than bundling them in the installer. Toolchain metadata lives in a
remote `manifest.json` so you can update pinned versions without shipping
a new IDE.

## Architecture

```
              ┌──────────────────────────────────────────────────────────┐
              │  Volt IDE                                                │
              │                                                          │
              │   ensureArmGcc / ensureCmakeNinja                        │
              │      └─► mirror.downloadAsset(key, …)                    │
              │            ├─► loadManifest()                            │
              │            │     ├─► ~/.volt/cache/manifest.json (24h)   │
              │            │     ├─► GET volt-toolchains/manifest.json   │
              │            │     └─► FALLBACK_MANIFEST (baked-in)        │
              │            │                                             │
              │            ├─► mirror URL  ──►┐                          │
              │            └─► upstream URL ──┴► SHA256 verify ──► OK    │
              └─────────────────────────────────────────────────────────┘

   The mirror lives at:
   github.com/PhilemonChiro/volt-toolchains
     └─ release: toolchains-2026.05
          ├─ manifest.json                    ← metadata (URLs, hashes, schema)
          ├─ arm-gnu-toolchain-13.2-darwin-arm64.tar.xz
          ├─ arm-gnu-toolchain-13.2-darwin-x86_64.tar.xz
          ├─ arm-gnu-toolchain-13.2-linux-x64.tar.xz
          ├─ cmake-3.30.5-macos-universal.tar.gz
          └─ ninja-1.12.1-mac.zip
```

- **`manifest.json`** is the source of truth for what versions, URLs, and
  hashes the IDE uses. The IDE caches it locally (24h TTL) and only re-fetches
  when stale.
- **`FALLBACK_MANIFEST`** in `src/main/toolchain-mirror.js` is a baked-in
  copy used when the live manifest can't be fetched (offline, GitHub down).
- **Source preference**: `Settings → Build & Toolchain → Toolchain download
  source` (`auto` | `mirror` | `upstream`).

## Manifest schema (v1)

```jsonc
{
  "schema_version": 1,
  "tag": "toolchains-2026.05",
  "min_ide_version": "2.0.10",            // IDE refuses manifests it's too old to understand
  "assets": {
    "<asset-key>": {
      "filename":   "...",                // basename of the tarball/zip
      "url":        "https://.../...",    // mirror URL on volt-toolchains
      "upstream":   "https://.../...",    // official source (fallback)
      "sha256":     "hex",                // verified after every download
      "size_bytes": 0,                    // informational
      "extract":    { "format": "tar.xz" | "tar.gz" | "zip", "strip_components": 1 },
      "install_to": "subdir",             // relative to ~/.volt/toolchains
      "exposes":    { "tool-name": "relative/path/inside/install_to" },
      "kind":       "compiler" | "build-system" | "sdk" | ...,
      "version":    "human-readable"
    }
  },
  "chip_requirements": {
    "<chip>": {
      "<platform>": ["asset-key", ...]    // assets required to build this chip on this platform
    }
  },
  "known_issues": [
    { "platform": "darwin", "min_macos": "12", "asset": "...", "note": "..." }
  ]
}
```

## Refresh workflow

To bump a toolchain version (or add a new asset):

1. **Edit** `src/main/toolchain-mirror.js` — change `FALLBACK_MANIFEST.assets`
   (update upstream URL, version string, `sha256: null`, `size_bytes: 0`).
2. **Authenticate** `gh` to the volt-toolchains repo:
   ```bash
   gh auth login
   ```
3. **Publish:**
   ```bash
   npm run publish:toolchains                        # all assets + manifest
   npm run publish:toolchains -- --only=cmake-...    # one asset + manifest
   npm run publish:toolchains -- --manifest-only     # metadata-only change
   npm run publish:toolchains -- --dry-run           # see what would happen
   ```
   The publisher:
     - Downloads each asset from upstream into `/tmp/volt-mirror/`
     - Computes SHA256 and size
     - Uploads the asset to release `toolchains-2026.05` (replacing any
       existing one with the same name)
     - Builds a fresh `manifest.json` with the computed hashes
     - Uploads `manifest.json` (always, even with `--only`)
4. **Verify live:**
   ```bash
   curl -sL https://github.com/PhilemonChiro/volt-toolchains/releases/download/toolchains-2026.05/manifest.json | jq .
   ```
5. **Optional:** commit the updated `toolchain-mirror.js` so the baked-in
   fallback also reflects the new hashes. Not required for users — they'll
   pick up the new manifest on next build via the remote fetch — but means
   offline first-runs use the latest versions too.

**No IDE release needed** for a toolchain version bump. Users get the new
versions on next build via the remote manifest.

## Why mirror

- **Reproducible installs.** v2.0.12 IDE always pulls the manifest that's
  live at build time. Upstream changes can't break your users.
- **Network reach.** Schools / corporate firewalls only need to whitelist
  `github.com/PhilemonChiro/volt-toolchains/*`, not five different vendor
  CDNs.
- **Integrity.** SHA256 verification catches partial downloads + corrupted
  caches the moment they happen.
- **Fast hosts.** GitHub's release CDN is generally faster than Arm.com.
- **Decoupled updates.** Bump toolchain versions without forcing every
  user to update the IDE.

## Settings deep dive

The `build.toolchainSource` setting:

- **auto** *(default)* — tries `mirror` first, falls back to `upstream`.
  Best for most users — pinned and resilient.
- **mirror** — only the Volt mirror, fails if the mirror is down or the
  asset isn't mirrored yet. Useful for offline labs that have whitelisted
  only github.com.
- **upstream** — skips the mirror entirely, downloads from official
  vendor sites. Useful for development / testing new versions before
  they're mirrored.

## Caching

The remote manifest is cached at `~/.volt/cache/manifest.json` with a
**24h TTL**. After that, the next build refreshes it. If the fetch fails,
the IDE keeps using the stale cache (better than nothing). If there's no
cache at all, the IDE uses the baked-in `FALLBACK_MANIFEST`.

To force a re-fetch:
```bash
rm ~/.volt/cache/manifest.json
```

## Limits

GitHub release asset limits:
- **2 GB per file** (hard, free + paid tiers)
- **No documented total cap** on assets per release
- **Free, uncapped bandwidth** for release downloads (not LFS)

Largest asset today is ARM GCC at ~280 MB. We're well under the ceiling.
ESP-IDF is *not* yet bundled as a single tarball (~800 MB compressed) —
it's still cloned + installed by the IDE on first use. Pre-built ESP-IDF
mirror is on the roadmap.
