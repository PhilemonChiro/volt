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

## 2. Point the IDE at it

In `src/main/toolchain-mirror.js` set:

```js
const MIRROR_TAG  = "toolchains-2026.05";
const MIRROR_BASE = `https://toolchains.<your-domain>/${MIRROR_TAG}`;
```

Optionally add a `mirrors: []` entry per asset (e.g. the direct-VPS URL as a
backup behind the Cloudflare one) — the client tries `url` → `mirrors[]` →
`upstream`, SHA256-checking each.

## 3. Publish (sign locally, upload to the volume)

The signing **private key never touches the VPS**. Sign locally, then rsync the
staged files into the volume.

```bash
# a) Build + SIGN the manifest and stage tarballs locally (skips GitHub entirely).
#    --stage-only downloads + hashes upstream tarballs and writes the signed
#    manifest.json into /tmp/volt-mirror, ready to rsync. Signing key stays local.
cd volt-ide
VOLT_TOOLCHAIN_SIGNING_KEY=/secure/volt-signing-private.pem \
  node scripts/publish-toolchains.js --stage-only
# -> /tmp/volt-mirror/{*.tar.xz, manifest.json (signed)}
# (Add --manifest-only to re-sign just manifest.json without re-downloading tarballs.)

# b) rsync the staged dir into the Dokploy volume on the VPS.
#    Find the volume mountpoint once:
#      ssh vps 'docker volume inspect toolchain-mirror_mirror-data -f "{{.Mountpoint}}"'
#    Then push into a per-tag subdir matching MIRROR_TAG:
rsync -av --chmod=D755,F644 /tmp/volt-mirror/ \
  vps:/var/lib/docker/volumes/toolchain-mirror_mirror-data/_data/toolchains-2026.05/
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
