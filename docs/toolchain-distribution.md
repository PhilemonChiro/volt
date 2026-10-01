# Toolchain distribution & trust

How the Volt IDE delivers compilers / build tools (ARM GCC, cmake, ninja,
picotool) to customer machines, and why it's safe to do so over the air.

## The problem this solves

The IDE downloads toolchains at runtime and then **executes them** to build
customer firmware. A per-file SHA256 only proves "these bytes match the
manifest" — it proves nothing if the **manifest itself** is unauthenticated.
Whoever could write to the mirror could publish a manifest pointing at a
back-doored compiler with a matching hash → remote code execution on every
customer, and a back-door compiled into every firmware they build
(a "trusting-trust" attack).

**Therefore the manifest itself is Ed25519-signed and verified fail-closed
against a key pinned inside the code-signed app** — the same trust model the
`.vlib` library path already uses (`src/main/vlib-verify.js`).

## Trust model (what the client trusts, and why)

| Source | Trusted? | How |
|--------|----------|-----|
| Baked-in `FALLBACK_MANIFEST` (in `toolchain-mirror.js`) | ✅ implicitly | It shipped inside the code-signed app bundle. No signature needed. |
| Remote `manifest.json` (mirror/CDN) | ⚠️ only if signed | Must carry a valid Ed25519 signature from a key in `toolchain-keys.json` **and** be at/above the rollback floor. |
| On-disk cache (`~/.volt/cache/manifest.json`) | ⚠️ re-verified | Written only after a successful verify; re-verified on read to defend against local tampering. |
| Each downloaded tarball | ✅ by SHA256 | Checked against the (now signed) manifest before extraction. |

**Because every tarball is SHA256-checked against a signed manifest, every
*mirror* is equally untrusted.** That's what makes hosting a pure
cost/availability choice (see "Where to host") rather than a trust boundary.

### Fail-closed by default

`toolchain-keys.json` **ships empty**. With no pinned key, remote manifests are
rejected and the IDE uses only the baked-in manifest — **OTA is off, but safe**.
OTA turns on only once you (1) pin a real public key and (2) start signing.

### Defenses in place

- **Signature** over canonical JSON of the whole manifest minus the `signature`
  field (`toolchain-trust.js`, reuses vlib's `canonical()`).
- **Rollback protection**: `manifest_version` is monotonic; the client persists
  the highest version it has accepted (`~/.volt/cache/manifest-version`) and
  refuses any manifest below it — a replayed older signed manifest can't
  downgrade you to a vulnerable toolchain.
- **Revocation**: a burned `manifest_version` can be black-listed in
  `toolchain-keys.json` `revoked: []`; a compromised key is set `status:
  "revoked"`.
- **`min_ide_version`** gate: the IDE refuses manifests it's too old to parse.

## Operations

### One-time: generate a signing keypair (offline)

Do this on a machine that is **not** the build/publish box if you can. Keep the
private key offline (ideally an HSM / hardware token). Never commit it — `.pem`
and `*-private.key` are gitignored.

```bash
# Ed25519 keypair
openssl genpkey -algorithm ed25519 -out volt-signing-private.pem
openssl pkey -in volt-signing-private.pem -pubout -out volt-signing-public.pem
```

Paste the **public** PEM into `volt-ide/src/main/toolchain-keys.json`:

```json
{
  "keys": [
    { "id": "volt-2026", "publicKeyPem": "-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----\n", "status": "active" }
  ],
  "revoked": []
}
```

Commit `toolchain-keys.json` (public key only) and ship it inside the app.

### Every publish

1. Bump `FALLBACK_MANIFEST.manifest_version` in `toolchain-mirror.js` (monotonic).
2. Publish + sign in one step — the private key is read from `--key` or
   `$VOLT_TOOLCHAIN_SIGNING_KEY`:

   ```bash
   cd volt-ide
   VOLT_TOOLCHAIN_SIGNING_KEY=/secure/volt-signing-private.pem \
     npm run publish:toolchains
   # or: node scripts/publish-toolchains.js --key=/secure/volt-signing-private.pem
   ```

   Publishing **fails fast** (before any 280 MB download) if no key is provided.
   `--allow-unsigned` exists only for a keyless bootstrap; clients with a pinned
   key will reject an unsigned manifest.

3. Keep the baked-in `FALLBACK_MANIFEST` in sync with what you published, so an
   offline first-run still works.

### Rotating / revoking a key

- **Rotate**: add the new public key (`status: "active"`) alongside the old one,
  ship an IDE update, publish signed with the new key, then a release later mark
  the old key `status: "revoked"`.
- **Revoke a bad manifest**: add its `manifest_version` to `revoked: []` and ship
  an IDE update (revocation reaches clients via the pinned, app-shipped keyfile,
  not the network — so it works even if the mirror is compromised).

## Where to host — self-hosted VPS (Dokploy)

Hosting is on **our own VPS via Dokploy**. Signing makes this purely an
availability/latency decision — a tampered origin (or edge cache) just fails
verification. Self-hosting actually raises the stakes on signing: a single VPS
is a more concentrated compromise target than GitHub, so **the pinned-key
signature is what keeps a popped VPS from serving a backdoored compiler.** Never
run this origin unsigned.

**Serving it (Dokploy):**
- Deploy a static file service (nginx / Caddy container) or **MinIO** (S3-style,
  good for content-addressed storage) that serves the release directory +
  `manifest.json`.
- Point `MIRROR_BASE` in `toolchain-mirror.js` at the service domain, e.g.
  `https://toolchains.<domain>/<tag>`. No code change beyond that constant.
- Serve immutable, **content-addressed** assets (tarball named with its sha256)
  so a file is never mutated in place — the equivalent of dropping GitHub's
  `--clobber`.

**Egress / latency (the one caveat):** toolchains are ~280 MB each. A VPS has
finite bandwidth and one region — a distant customer pulling 280 MB direct is
slow, and an install burst can saturate the uplink. Put **Cloudflare (free tier)
in front of the Dokploy origin**: it edge-caches the large immutable tarballs
(zero egress, global speed) and hides the origin IP. The VPS stays source of
truth; because every byte is SHA256-checked against a signed manifest, the edge
cache is untrusted anyway — this is free security-wise.

**Failover is built in:** each asset supports a `mirrors: []` list. The client
tries `url` → `mirrors[]` → `upstream`, SHA256-checking each — so you can list
the Cloudflare URL, the direct VPS URL, and the original upstream, and clients
degrade gracefully if one is down. Changing hosts is a manifest edit, not a
re-architecture.

**Origin hardening (because it's now yours):** lock down the upload path (only
the publish box / CI can write the release dir), keep the signing **private key
off the VPS entirely** (sign locally, upload the already-signed manifest), and
treat the VPS as replaceable — the trust root is the pinned key in the app, not
the server.

## ESP32 compiler-cache artifacts

Volt can ship warmed ESP-IDF compiler caches through the same signed toolchain
manifest. This is deliberately a **ccache artifact**, not a copied ESP-IDF
`build/` directory: CMake/Ninja build folders contain absolute source/build
paths and are not safe to replay on another machine. ccache is content-addressed
and can be seeded from CI, then reused by a user's local ESP-IDF build.

Flow:

1. Install an ESP32 toolchain manifest that exposes `ccache` on `PATH`.
2. Build a representative Volt firmware profile to warm
   `~/.volt/cache/ccache/esp32`.
3. Package the warmed cache:

   ```sh
   volt cache package esp32 -o /tmp/volt-prebuilt-esp32-ccache.tar.gz
   ```

4. Add a manifest asset like:

   ```json
   {
     "filename": "volt-prebuilt-esp32-ccache.tar.gz",
     "url": "https://toolchains.example.com/toolchains-2026.05/volt-prebuilt-esp32-ccache.tar.gz",
     "source_file": "/tmp/volt-prebuilt-esp32-ccache.tar.gz",
     "sha256": "...",
     "size_bytes": 123,
     "extract": { "format": "tar.gz", "strip_components": 0 },
     "install_to": "cache/ccache/esp32",
     "exposes": {},
     "kind": "compiler-cache",
     "version": "esp32-idf5.4-volt-runtime-<hash>"
   }
   ```

5. Add that asset key to `chip_requirements.esp32.<platform>` alongside the
   `ccache` binary asset. `volt toolchain install esp32` downloads, verifies and
   extracts it like any other toolchain piece.

At build time the CLI detects `ccache` on the resolved toolchain `PATH` and
sets:

- `IDF_CCACHE_ENABLE=1`
- `CCACHE_DIR=~/.volt/cache/ccache/esp32`
- `CCACHE_COMPILERCHECK=content`
- `CCACHE_NOHASHDIR=true`
- `CCACHE_BASEDIR=/`

If the cache is absent, stale, or only partially useful, ESP-IDF still builds
normally and gradually warms the cache locally. The cache is an accelerator, not
a correctness dependency.

## Open items (not yet done)

- **App auto-update** (`electron-updater`): required so fixes to the IDE (and to
  bundled `worker.py` / SDK) can actually reach shipped installs. Without it you
  can't patch any of the above in the field.
- ~~Pin git-cloned SDKs to exact commit SHAs~~ **DONE** — esp-idf/pico-sdk/
  picotool/ESP8266 in `toolchain.js` now `cloneAtSha()`: fetch-by-SHA + verify
  the checkout (`PINNED_SDK` map). Bump a SHA there to upgrade.
- ~~Zip-slip / path-traversal guard on archive extraction~~ **DONE** in the Go
  CLI extractor.
- Consider making **compiler/worker updates explicit/opt-in** (lockfile-pinned
  per project); reserve *silent* OTA for signed security patches, so an update
  can't silently change the C a customer's firmware compiles to.

## Files

| File | Role |
|------|------|
| `src/main/toolchain-trust.js` | Ed25519 sign/verify, fail-closed |
| `src/main/toolchain-keys.json` | Pinned **public** keys (ships empty) |
| `src/main/toolchain-mirror.js` | Manifest load + verify + rollback + mirror failover + tarball SHA256 |
| `scripts/publish-toolchains.js` | Publishes + **signs** the manifest |
| `test/toolchain-trust.test.js` | Offline crypto tests (`npm run test:trust`) |
