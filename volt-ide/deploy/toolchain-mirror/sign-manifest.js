#!/usr/bin/env node
// Sign a staged (unsigned) toolchain manifest LOCALLY, so the Ed25519 private key
// never touches the VPS. Pair this with stage-on-vps.sh (which downloads + hashes
// the tarballs and writes the unsigned manifest on the VPS).
//
// Usage:
//   VOLT_TOOLCHAIN_SIGNING_KEY=~/.volt/secrets/volt-toolchain-signing.pem \
//     node deploy/toolchain-mirror/sign-manifest.js <unsigned-manifest.json> [out.json]
//
// Then scp the signed manifest into the mirror volume on the VPS:
//   scp <out.json> vps:/…/mirror-data/_data/<tag>/manifest.json

const fs = require("fs");
const trust = require("../../src/main/toolchain-trust");

const inPath  = process.argv[2];
const outPath = process.argv[3] || (inPath ? inPath.replace(/\.json$/, "") + ".signed.json" : "");
const keyPath = process.env.VOLT_TOOLCHAIN_SIGNING_KEY;

if (!inPath || !keyPath) {
    console.error("usage: VOLT_TOOLCHAIN_SIGNING_KEY=<private.pem> \\");
    console.error("         node deploy/toolchain-mirror/sign-manifest.js <manifest.json> [out.json]");
    process.exit(2);
}

const manifest = JSON.parse(fs.readFileSync(inPath, "utf8"));
const signed = trust.sign(manifest, fs.readFileSync(keyPath, "utf8"));
fs.writeFileSync(outPath, JSON.stringify(signed, null, 2));
console.log(`signed -> ${outPath}  (manifest_version=${signed.manifest_version})`);

// Self-check against the PINNED public key so a wrong key is caught here, before
// upload — not silently by every client rejecting the manifest later.
const v = trust.verify(signed);
if (v.ok) {
    console.log(`✓ verifies against pinned toolchain-keys.json (key: ${v.keyId})`);
} else {
    console.error(`✗ does NOT verify against pinned toolchain-keys.json: ${v.reason}`);
    console.error("  The signing key does not match the pinned public key — do NOT upload this.");
    process.exit(1);
}
