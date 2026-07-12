// Offline tests for toolchain manifest signing/verification (toolchain-trust.js).
// Uses an ephemeral Ed25519 keypair generated in-process — no network, no files,
// no dependency on the pinned toolchain-keys.json. Run: node test/toolchain-trust.test.js

const crypto = require("crypto");
const assert = require("assert");
const trust = require("../src/main/toolchain-trust");

let pass = 0, fail = 0;
function check(name, fn) {
    try { fn(); console.log(`  ok   ${name}`); pass++; }
    catch (e) { console.log(`  FAIL ${name}: ${e.message}`); fail++; }
}

// Ephemeral signer + the pinned key-set a client would ship.
const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
const privPem = privateKey.export({ type: "pkcs8", format: "pem" });
const pubPem  = publicKey.export({ type: "spki", format: "pem" });
const keyset  = { keys: [{ id: "test", publicKeyPem: pubPem, status: "active" }], revoked: [] };

const baseManifest = {
    schema_version: 1,
    manifest_version: 5,
    tag: "toolchains-test",
    assets: { gcc: { sha256: "abc", size_bytes: 1 } },
};

check("valid signature verifies against the pinned key", () => {
    const signed = trust.sign(baseManifest, privPem);
    const v = trust.verify(signed, { keyset });
    assert.strictEqual(v.ok, true, v.reason);
    assert.strictEqual(v.keyId, "test");
});

check("tampering with signed content is rejected", () => {
    const signed = trust.sign(baseManifest, privPem);
    signed.assets.gcc.sha256 = "deadbeef"; // swap in a malicious hash post-signing
    assert.strictEqual(trust.verify(signed, { keyset }).ok, false);
});

check("a different key does not verify", () => {
    const signed = trust.sign(baseManifest, privPem);
    const other = crypto.generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" });
    const otherSet = { keys: [{ id: "other", publicKeyPem: other, status: "active" }], revoked: [] };
    assert.strictEqual(trust.verify(signed, { keyset: otherSet }).ok, false);
});

check("missing signature is rejected", () => {
    assert.strictEqual(trust.verify(baseManifest, { keyset }).ok, false);
});

check("empty key-set fails closed", () => {
    const signed = trust.sign(baseManifest, privPem);
    assert.strictEqual(trust.verify(signed, { keyset: { keys: [], revoked: [] } }).ok, false);
});

check("revoked key is not usable", () => {
    const signed = trust.sign(baseManifest, privPem);
    const revokedSet = { keys: [{ id: "test", publicKeyPem: pubPem, status: "revoked" }], revoked: [] };
    assert.strictEqual(trust.verify(signed, { keyset: revokedSet }).ok, false);
});

check("revoked manifest_version is rejected even with a valid signature", () => {
    const signed = trust.sign(baseManifest, privPem);
    const revSet = { keys: keyset.keys, revoked: ["5"] };
    assert.strictEqual(trust.verify(signed, { keyset: revSet }).ok, false);
});

check("key reordering / whitespace does not change the signed bytes", () => {
    const signed = trust.sign(baseManifest, privPem);
    // Re-serialise through JSON to shuffle key order + strip formatting; a
    // canonical signer must still verify the logically-identical object.
    const roundTripped = JSON.parse(JSON.stringify({ signature: signed.signature, assets: signed.assets, tag: signed.tag, manifest_version: signed.manifest_version, schema_version: signed.schema_version }));
    assert.strictEqual(trust.verify(roundTripped, { keyset }).ok, true);
});

console.log(`\ntoolchain-trust: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
