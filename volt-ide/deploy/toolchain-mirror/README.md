# Toolchain mirror — Dokploy deploy

Self-hosted origin that serves `manifest.json` + toolchain tarballs to the Volt
IDE. Read-only nginx static server; content is pushed in via rsync. Integrity is
enforced client-side (Ed25519 signature on the manifest + per-tarball SHA256), so
this box only needs to be *available*, not *trusted*. See
`../../../docs/toolchain-distribution.md` for the trust model.

```
deploy/toolchain-mirror/
  docker-compose.yml   # Dokploy "Docker Compose" app
  Dockerfile           # nginx:alpine + mirror.conf
  mirror.conf          # read-only, cache-aware server block
  README.md            # this file
```

## 1. Deploy on Dokploy

1. **Create app** → *Docker Compose* → point it at this repo, **Compose path**
   `volt-ide/deploy/toolchain-mirror/docker-compose.yml`.
2. **Domains** → add `toolchains.<your-domain>` → port **80**, enable HTTPS
   (Let's Encrypt). Dokploy injects the Traefik labels; the service is already on
   `dokploy-network`.
3. **Deploy.** Verify: `curl https://toolchains.<your-domain>/healthz` → `ok`.

The `mirror-data` volume persists the tarballs + manifest across redeploys.

### Human file browser

The same nginx service exposes a read-only browser at:

```text
https://toolchains.<your-domain>/browse/
```

It uses nginx `autoindex` over the public mirror volume. This is intentionally
download-only: the server still rejects non-`GET`/`HEAD` methods, and uploads
still happen out-of-band through rsync/SSH or the staging scripts.

## 2. Point the IDE at it

In `src/main/toolchain-mirror.js` set:

```js
const MIRROR_TAG  = "toolchains-2026.05";
const MIRROR_BASE = `https://toolchains.<your-domain>/${MIRROR_TAG}`;
```

Optionally add a `mirrors: []` entry per asset (e.g. the direct-VPS URL as a
backup behind the Cloudflare one) — the client tries `url` → `mirrors[]` →
`upstream`, SHA256-checking each.

## 3. Publish

Two goals at once: the ~600 MB of upstream downloads must **not** run on a metered
laptop, and the signing **private key must never touch the VPS**. So: download +
hash on the VPS, sign on the laptop.

### Recommended — split flow (data-safe + key-safe)

```bash
# --- ON THE VPS ---  downloads tarballs (VPS bandwidth), writes an UNSIGNED
# manifest, and drops the tarballs straight into the mirror volume.
# Find the volume path first:
#   docker volume ls | grep mirror-data
#   docker volume inspect <name> -f '{{.Mountpoint}}'
git clone https://github.com/PhilemonChiro/volt.git   # or reuse Dokploy's clone
./volt/volt-ide/deploy/toolchain-mirror/stage-on-vps.sh \
    ./volt  <volume-_data-path>  toolchains-2026.05
# -> prints the path of the UNSIGNED manifest.json to fetch next.

# --- ON YOUR LAPTOP ---  sign the tiny manifest with the key kept in ~/.volt/secrets.
scp vps:/tmp/…/manifest.json ./unsigned-manifest.json
VOLT_TOOLCHAIN_SIGNING_KEY=~/.volt/secrets/volt-toolchain-signing.pem \
  node volt-ide/deploy/toolchain-mirror/sign-manifest.js ./unsigned-manifest.json ./manifest.json
# self-verifies against the pinned key; refuses to output if the key is wrong.

# --- BACK ON THE VPS ---  drop the signed manifest into the volume.
scp ./manifest.json vps:<volume-_data-path>/toolchains-2026.05/manifest.json
```

Until the signed `manifest.json` is in place, clients reject the missing/unsigned
remote manifest and safely fall back to the baked-in one (→ upstream tarballs).

### Simple — all-in-one (only if the laptop's bandwidth is fine)

```bash
cd volt-ide
VOLT_TOOLCHAIN_SIGNING_KEY=~/.volt/secrets/volt-toolchain-signing.pem \
  node scripts/publish-toolchains.js --stage-only        # downloads+hashes+signs locally
rsync -av /tmp/volt-mirror/ vps:<volume-_data-path>/toolchains-2026.05/
```

Immutability: never overwrite an existing tarball in place — bump `MIRROR_TAG`
(or use content-addressed filenames) so a filename's bytes never change. Only
`manifest.json` is meant to be replaced (and it's `no-cache`).

## 4. Cloudflare in front (recommended)

Toolchains are ~280 MB each; a VPS has finite bandwidth + one region. Proxy the
origin through Cloudflare (free) to edge-cache the immutable tarballs and hide
the origin IP.

- DNS: `toolchains` → your VPS, **proxied** (orange cloud).
- Cache: nginx already sends the right `Cache-Control`
  (`immutable` for tarballs, `no-cache` for `manifest.json`), which Cloudflare
  honours. Optionally add a Cache Rule: *Eligible for cache* on `*.tar.*`/`*.zip`,
  *Bypass cache* on `*/manifest.json`.
- Because every byte is SHA256-checked against a signed manifest, the edge cache
  is untrusted anyway — safe by construction.

## Security posture

- **Read-only:** non-GET/HEAD returns 405; no HTTP upload path.
- **No trust in the host:** signature + SHA256 verified client-side; the VPS is
  replaceable, the trust root is the pinned key in the app.
- **Keep the signing key off the VPS.** Lock the rsync/SSH upload path to the
  publish box only. `server_tokens off`, `autoindex off`.
