# Volt IDE Toolchain Mirror

The IDE downloads chip toolchains (ARM GCC, cmake, ninja, ...) on first use
rather than bundling them in the installer. This file explains how the mirror
works and how to refresh pinned versions.

## Architecture

```
                        ┌────────────────────────────────────────────┐
                        │  Volt IDE                                  │
                        │   ensureArmGcc / ensureCmakeNinja          │
                        │      └─► mirror.downloadAsset(key, …)      │
                        │            ┌─────────┐    ┌─────────────┐  │
                        │            │ mirror  │ or │  upstream   │  │
                        │            └────┬────┘    └──────┬──────┘  │
                        └─────────────────┼────────────────┼─────────┘
                                          │                │
                ┌─────────────────────────▼─┐       ┌──────▼─────────────────┐
                │ github.com/PhilemonChiro/ │       │ developer.arm.com,     │
                │   volt/releases/download/ │       │ github.com/Kitware/…,  │
                │   toolchains-YYYY.MM      │       │ ninja-build releases   │
                └───────────────────────────┘       └────────────────────────┘
```

* **Single source of truth:** `src/main/toolchain-mirror.js` holds the
  manifest — upstream URL, mirror URL, and SHA256 for each asset.
* **Source preference:** `Settings → Build & Toolchain → Toolchain download
  source` (`auto` | `mirror` | `upstream`).
* **Resilience:** `auto` tries mirror first, falls back to upstream on any
  failure (404, hash mismatch, timeout).

## Pinned versions (`toolchains-2026.05`)

| Asset | Version | Platforms |
|---|---|---|
| ARM GCC (`arm-none-eabi`) | 13.2 rel1 | darwin-arm64, darwin-x86_64, linux-x64 |
| cmake | 3.30.5 | macOS universal |
| ninja | 1.12.1 | macOS |

## Refresh workflow

When you want to bump a toolchain version:

1. **Edit** `src/main/toolchain-mirror.js` — change the upstream URL and
   mirror filename for the asset, set `sha256: null` (so the publish
   script repopulates it).
2. **Authenticate** the `gh` CLI to the volt repo:
   ```bash
   gh auth login
   ```
3. **Run** the publisher:
   ```bash
   npm run publish:toolchains            # all assets
   npm run publish:toolchains -- --only=cmake-3.30.5-macos-universal   # one asset
   npm run publish:toolchains -- --dry-run    # see what would happen
   ```
   The script:
     * Downloads each asset from upstream
     * Computes its SHA256
     * Creates the release tagged `MIRROR_TAG` if it doesn't exist
     * Uploads the asset (replacing any existing one of the same name)
     * Patches `toolchain-mirror.js` with the computed SHA256
4. **Commit** the updated `toolchain-mirror.js` (now pinned with hashes).
5. **Bump** the IDE version in `package.json` and tag a release.

## Why mirror

* **Reproducible installs.** v2.0.10 IDE always pulls the same compiler.
  Upstream changes (a new `13.2 rel2`, an old version pulled, a CDN tweak)
  can't break your users.
* **Network reach.** Schools / corporate firewalls only need to whitelist
  `github.com/PhilemonChiro/volt/*`, not five different vendor CDNs.
* **Integrity.** SHA256 verification catches partial downloads + corrupted
  caches the moment they happen.
* **Fast hosts.** GitHub's release CDN is generally faster than Arm.com.

## Adding a new asset

Add a new entry to `MANIFEST` in `toolchain-mirror.js`:

```js
"openocd-0.12-darwin-arm64": {
    upstream:  "https://example.com/openocd-0.12-darwin-arm64.tar.gz",
    mirror:    `${MIRROR_BASE}/openocd-0.12-darwin-arm64.tar.gz`,
    sha256:    null,
    sizeBytes: null,
},
```

Then run `npm run publish:toolchains` to upload + populate the hash.

## Settings deep dive

The `build.toolchainSource` setting is read by `mirror.getPreference()`:

* **auto** *(default)* — tries `mirror` first, falls back to `upstream`.
  Best for most users — pinned and resilient.
* **mirror** — only the Volt mirror, fails if the mirror is down or the
  asset isn't mirrored yet. Useful for offline labs that have whitelisted
  only github.com.
* **upstream** — skips the mirror entirely, downloads from official
  vendor sites. Useful for development / testing new versions before
  they're mirrored.

## Limits

GitHub release asset limits as of writing:
* **2 GB per file** (hard limit, free + paid tiers)
* **No documented total cap** on assets per release
* **Free, uncapped bandwidth** for release downloads (not LFS)

Every asset we ship today is well under 2 GB (largest is ARM GCC at
~280 MB). The 2 GB ceiling is the reason ESP-IDF is *not* yet bundled as
a single tarball — that would be ~800 MB compressed and is on the
roadmap for a future release.
