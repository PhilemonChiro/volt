# Volt Registry Signer

The maintainer's **offline** `.vlib` signing app — a small desktop tool for the
one person who holds the registry's private key (you). Review each pending
submission, then sign + publish it. **The private key never leaves this machine**
and never touches the Grid server (that's the whole point — see H1 in the
security assessment).

```
registry-signer/
  main.js       # Electron main: config, canonical+sign (Node crypto), IPC
  preload.js    # contextBridge — renderer can only call vetted channels
  index.html    # UI (CSP-locked)
  renderer.js   # UI logic
  styles.css
  start.sh      # launch reusing volt-ide's Electron
```

## Run

```bash
./start.sh          # or: npm start
```

First launch opens **Settings** — fill in:
- **Grid URL** — `https://grid.voltembedded.com`
- **Admin secret** — the Grid's `ADMIN_SECRET`
- **Signing key** — path to your Ed25519 private key (`~/.volt/secrets/vlib-signing.pem`)

These save to `~/.volt/registry-signer.json` (mode 600, outside any repo).

## The flow

1. A user submits a library via the IDE/API → it lands **pending**.
2. Open the signer → the pending queue lists it.
3. Click it → review the **driver C source**, metadata, capabilities, and the
   exact **signed hash**.
4. **Sign & Publish** → the app canonicalizes the content, signs it locally with
   your key, posts the detached `{hash, signature}`, and the Grid verifies it
   against the pinned **public** key and publishes. The app then re-downloads and
   confirms the published `.vlib` verifies (✓).
   Or **Reject** to bounce it.

## Requirements

- The Grid must be running the offline-publish build (endpoints
  `…/review/{prefix}/{version}/content` + `…/publish`) with `VLIB_PUBLIC_KEY`
  set (no private key on the server).
- Dev launch reuses `../volt-ide/node_modules` Electron. To ship it standalone,
  `npm install` here and `npm run pack:mac|linux|win`.

## Security

- Private key read only in the main process; never exposed to the renderer or
  the network.
- `contextIsolation: true`, `nodeIntegration: false`, strict CSP.
- Config (incl. admin secret) is local, mode 600. Nothing is committed.
