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

## Where to host (GitHub vs your CDN)

Signing makes this a **cost/availability decision, not a security one** — a
tampered mirror just fails verification.

- **Now:** GitHub Releases (`PhilemonChiro/volt-toolchains`) is fine. Two hygiene
  fixes: **sign the manifest** (done) and **stop `--clobber`ing** — prefer
  content-addressed, immutable assets (name tarballs with their sha256) so a
  release asset is never mutated in place.
- **At commercial volume:** move the origin to object storage + CDN. Cloudflare
  R2 is the standout because toolchains are ~280 MB each and R2 has **zero egress
  fees** — verify the numbers against your real usage before committing. Keep
  GitHub as a fallback mirror.
- **Design for it today:** each asset supports a `mirrors: []` list. The client
  tries `url` → `mirrors[]` → `upstream`, SHA256-checking each. Migrating hosts
  becomes a manifest edit, not a re-architecture.

## Open items (not yet done)

- **App auto-update** (`electron-updater`): required so fixes to the IDE (and to
  bundled `worker.py` / SDK) can actually reach shipped installs. Without it you
  can't patch any of the above in the field.
- **Pin git-cloned SDKs** (esp-idf, pico-sdk, picotool source in `toolchain.js`)
  to exact commit SHAs — currently cloned from mutable branches/tags with no
  integrity check.
- **Zip-slip / path-traversal** guard on archive extraction.
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
