// .vlib signature verification — the trust root of library import.
//
// A .vlib is a signed JSON envelope. We verify authenticity + integrity offline
// against a PINNED key-set the IDE ships (registry-keys.json). No network, no
// trust in the transport. Signing happens server-side (Go, crypto/ed25519); this
// is the client half.
//
// Signed content = canonical({manifest, device, driver, header}). The envelope
// also carries `hash` (sha256 of the canonical bytes, for display + lockfile
// pinning) and `signature` (Ed25519 over the canonical bytes).

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

// Deterministic canonical JSON: recursively sort object keys. Both signer (Go)
// and verifier (Node) must produce identical bytes. NOTE: for full spec fidelity
// this should be upgraded to RFC 8785 (JCS) number/unicode handling; for the
// string+integer content we sign, sorted-key JSON is deterministic and matches
// Go's json.Marshal(map) ordering.
function canonical(value) {
    if (value === null || typeof value !== "object") return JSON.stringify(value);
    if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
    const keys = Object.keys(value).sort();
    return "{" + keys.map(k => JSON.stringify(k) + ":" + canonical(value[k])).join(",") + "}";
}

function signedBytes(envelope) {
    return Buffer.from(canonical({
        manifest: envelope.manifest,
        device: envelope.device,
        driver: envelope.driver,
        header: envelope.header,
    }), "utf8");
}

function keysPath() {
    return path.join(__dirname, "registry-keys.json");
}

// { keys: [{ id, publicKeyPem, status }], revoked: [ "<content_hash>", … ] }
function loadKeySet(p) {
    try { return JSON.parse(fs.readFileSync(p || keysPath(), "utf8")); }
    catch (_) { return { keys: [], revoked: [] }; }
}

// Verify an envelope. Returns { ok, reason?, keyId?, hash? }.
// Fails closed: an empty/absent key-set → nothing verifies (correct until the
// real registry key is pinned).
function verify(envelope, opts = {}) {
    if (!envelope || typeof envelope !== "object") return { ok: false, reason: "not an object" };
    if (envelope.schema !== 1) return { ok: false, reason: "unsupported schema" };
    if (!envelope.manifest || !envelope.device || !envelope.driver || !envelope.header) {
        return { ok: false, reason: "missing required sections" };
    }

    const bytes = signedBytes(envelope);
    const sha = "sha256:" + crypto.createHash("sha256").update(bytes).digest("hex");
    if (envelope.hash !== sha) return { ok: false, reason: "content hash mismatch (tampered)" };

    const sig = String(envelope.signature || "");
    if (!sig.startsWith("ed25519:")) return { ok: false, reason: "missing/unknown signature" };
    let sigBuf;
    try { sigBuf = Buffer.from(sig.slice("ed25519:".length), "base64"); }
    catch (_) { return { ok: false, reason: "malformed signature" }; }
    if (sigBuf.length !== 64) return { ok: false, reason: "bad signature length" };

    const keyset = loadKeySet(opts.keysPath);
    if ((keyset.revoked || []).includes(sha)) return { ok: false, reason: "revoked version" };

    const active = (keyset.keys || []).filter(k => k.status !== "revoked");
    if (!active.length) return { ok: false, reason: "no pinned signing keys" };

    for (const k of active) {
        try {
            const pub = crypto.createPublicKey(k.publicKeyPem);
            if (pub.asymmetricKeyType === "ed25519" && crypto.verify(null, bytes, pub, sigBuf)) {
                return { ok: true, keyId: k.id, hash: sha };
            }
        } catch (_) { /* try next key */ }
    }
    return { ok: false, reason: "signature not verified by any pinned key" };
}

module.exports = { verify, canonical, signedBytes };
