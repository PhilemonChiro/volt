// toolchain-trust.js — Ed25519 signing + verification for the toolchain manifest.
//
// WHY THIS EXISTS
// The toolchain manifest names the SHA256 of every compiler / build tool the IDE
// downloads and then *executes* to build customer firmware. The per-file SHA256
// only proves "these bytes match the manifest" — it proves nothing if the
// manifest itself is unauthenticated. Whoever can write to the mirror could
// publish a manifest pointing at a back-doored compiler with a matching hash and
// get remote code execution on every customer (a classic trusting-trust attack).
//
// So the manifest itself must be signed, and verified fail-closed against a key
// pinned inside the (code-signed) app bundle — exactly like .vlib libraries are
// already handled in vlib-verify.js. This module is the toolchain half of that.
//
// TRUST MODEL
//   - The baked-in FALLBACK_MANIFEST is trusted implicitly: it shipped inside the
//     signed app. It carries no signature and never needs one.
//   - Any manifest fetched from the network (or read back from the on-disk cache)
//     MUST carry a valid Ed25519 signature from a pinned key, or it is rejected
//     and the caller falls back to the baked-in manifest.
//   - Signing happens offline with a private key that NEVER lives in the repo.
//   - toolchain-keys.json ships EMPTY, so verification fails closed until a real
//     key is pinned. Empty keys => remote manifests are ignored => OTA is off but
//     safe. This is deliberate: OTA turns on only once you pin a key AND sign.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

// Reuse the exact canonicalisation the .vlib signer/verifier uses, so the two
// trust paths can never drift apart. canonical() = deterministic JSON with
// recursively sorted object keys.
const { canonical } = require("./vlib-verify");

// The bytes we sign / verify are the whole manifest EXCEPT the `signature`
// field itself — a value cannot contain its own signature.
function signedBytes(manifest) {
    const { signature, ...rest } = manifest;
    return Buffer.from(canonical(rest), "utf8");
}

function keysPath() {
    return path.join(__dirname, "toolchain-keys.json");
}

// { keys: [{ id, publicKeyPem, status }], revoked: [ "<manifest_version>", … ] }
// Missing / unreadable file => empty set => fail closed.
function loadKeySet(p) {
    try { return JSON.parse(fs.readFileSync(p || keysPath(), "utf8")); }
    catch (_) { return { keys: [], revoked: [] }; }
}

// Sign a manifest object. Returns a NEW object with `signature` attached.
// privateKeyPem is a PKCS#8 Ed25519 private key (kept offline, never in the repo).
function sign(manifest, privateKeyPem) {
    const key = crypto.createPrivateKey(privateKeyPem);
    if (key.asymmetricKeyType !== "ed25519") throw new Error("signing key is not Ed25519");
    const { signature, ...rest } = manifest;
    const sig = crypto.sign(null, Buffer.from(canonical(rest), "utf8"), key);
    return { ...rest, signature: "ed25519:" + sig.toString("base64") };
}

// Verify a manifest's signature. Fails CLOSED (any doubt => not ok).
// opts.keyset — pass a key-set object directly (used by tests); otherwise the
//               pinned toolchain-keys.json next to this file is loaded.
// opts.keysPath — alternative path to the pinned key-set file.
// Returns { ok, reason?, keyId? }.
function verify(manifest, opts = {}) {
    if (!manifest || typeof manifest !== "object") return { ok: false, reason: "not an object" };

    const sig = String(manifest.signature || "");
    if (!sig.startsWith("ed25519:")) return { ok: false, reason: "missing/unknown signature" };
    let sigBuf;
    try { sigBuf = Buffer.from(sig.slice("ed25519:".length), "base64"); }
    catch (_) { return { ok: false, reason: "malformed signature" }; }
    if (sigBuf.length !== 64) return { ok: false, reason: "bad signature length" };

    const keyset = opts.keyset || loadKeySet(opts.keysPath);

    // Revocation: a burned manifest_version can be black-listed even if its
    // signature is otherwise valid.
    const ver = String(manifest.manifest_version ?? "");
    if (ver && (keyset.revoked || []).includes(ver)) return { ok: false, reason: "revoked manifest version" };

    const active = (keyset.keys || []).filter(k => k.status !== "revoked");
    if (!active.length) return { ok: false, reason: "no pinned signing keys" };

    const bytes = signedBytes(manifest);
    for (const k of active) {
        try {
            const pub = crypto.createPublicKey(k.publicKeyPem);
            if (pub.asymmetricKeyType === "ed25519" && crypto.verify(null, bytes, pub, sigBuf)) {
                return { ok: true, keyId: k.id };
            }
        } catch (_) { /* malformed pinned key — try the next one */ }
    }
    return { ok: false, reason: "signature not verified by any pinned key" };
}

module.exports = { sign, verify, signedBytes };
