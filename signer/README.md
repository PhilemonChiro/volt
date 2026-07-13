# Volt Registry Signer

The maintainer's **offline `.vlib` signing app** — your private notary tool. It's
how a *pending* library submission becomes a *trusted, published* one. It is **not
shipped to users**; only you run it.

## Trust model
- The Ed25519 **private key** and the Grid **admin secret** live only in this app's
  **main process** (`main.js`) — the UI (renderer) never sees them.
- Signing happens locally over the canonical bytes fetched from the Grid. The key
  **never leaves your machine**, never touches the VPS.
- The Grid holds only the **public** key and verifies your signature before
  publishing (see grid `service.Publish`). A VPS breach cannot forge a library.

## Run
```bash
./signer.sh          # reuses ../volt-ide's Electron — no separate install
# or:  npm start
```
First launch opens **Settings** — set:
- **Grid URL** (e.g. `https://grid.sigma.co.zw`)
- **Admin secret** (grid's `ADMIN_SECRET`)
- **Signing key file** (default `~/.volt/secrets/vlib-signing.pem`)

Config is saved to `~/.volt/signer-config.json` (mode 600, outside any repo).

## Workflow
1. **PENDING** queue (left) lists submissions awaiting review.
2. Click one → read its **metadata + `driver.c`** (this is you vouching for the code).
3. **Sign & Publish** → the app canonicalizes, signs locally, posts `{hash,signature}`;
   Grid verifies against the pinned key and publishes. The app then re-downloads
   the published `.vlib` and confirms it **verifies against the pinned key**.
4. Or **Reject** with a reason.

## Same engine as the CLI
This is the GUI counterpart of `grid/scripts/sign-vlib.mjs` — identical canonical
bytes, endpoints, and key handling. Use whichever fits.

## Security notes
- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, strict CSP
  (`default-src 'none'`, no renderer network) — the UI is inert; all privileged
  work is in main over IPC.
- Never commit `~/.volt/signer-config.json` or the key. Keep the key backed up
  offline — losing it means re-keying the whole registry.
