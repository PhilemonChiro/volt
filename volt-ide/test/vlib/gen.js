// Golden .vlib corpus generator. Produces a set of signed fixtures (valid + one
// per attack) plus an expected-verdict manifest. This is the SHARED CONTRACT:
// the IDE importer (JS) and the future registry pre-screen (Go) must both reach
// the exact same verdict on every fixture, or they've drifted.
//
//   node test/vlib/gen.js     # (re)generate fixtures + test key-set
//
// The keypair here is a TEST key, written into test/vlib/keys — it has nothing to
// do with the real registry signing key (src/main/registry-keys.json stays empty
// / fail-closed).

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const verify = require("../../src/main/vlib-verify.js");

const HERE = __dirname;
const FIX = path.join(HERE, "fixtures");
const KEYS = path.join(HERE, "keys");
fs.mkdirSync(FIX, { recursive: true });
fs.mkdirSync(KEYS, { recursive: true });

const kp = crypto.generateKeyPairSync("ed25519");
const pubPem = kp.publicKey.export({ type: "spki", format: "pem" });

function sign(env) {
    const bytes = verify.signedBytes(env);
    env.hash = "sha256:" + crypto.createHash("sha256").update(bytes).digest("hex");
    env.signature = "ed25519:" + crypto.sign(null, bytes, kp.privateKey).toString("base64");
    return env;
}

// A clean, HAL-only i2c device as the baseline.
function base(over = {}) {
    const e = {
        schema: 1,
        manifest: { name: "GoldTest", prefix: "goldtest", version: "1.0.0", interface: "i2c",
                    capabilities: ["i2c"], author: "gh:test", trustTier: "verified" },
        device: { name: "GoldTest", category: "sensor", interface: "i2c", default_address: "0x40",
                  description: "golden fixture", c_prefix: "goldtest", c_source: "driver.c",
                  init_args: "{bus_id}, {addr}", methods: { read: { returns: "float", params: [] } } },
        driver: { common:
            "volt_error_t goldtest_init(goldtest_t*d,uint8_t bus_id,uint8_t addr){d->bus_id=bus_id;d->addr=addr;return VOLT_OK;}\n" +
            "float goldtest_read(goldtest_t*d){return (float)volt_i2c_read_reg16(d->bus_id,d->addr,0);}" },
        header: { struct_name: "goldtest_t", fields: [["bus_id", "uint8_t"], ["addr", "uint8_t"]],
                  init_params: [["bus_id", "uint8_t"], ["addr", "uint8_t"]],
                  methods: [{ name: "read", ret: "float", params: [] }] },
    };
    if (over.manifest) Object.assign(e.manifest, over.manifest);
    if (over.device) Object.assign(e.device, over.device);
    if (over.driver) e.driver = over.driver;
    if (over.schema !== undefined) e.schema = over.schema;
    return e;
}

// name → { env, expect: { ok, stage? }, revoke? }
const cases = {};

// --- should PASS ---
cases["valid-i2c"]       = { env: sign(base()), expect: { ok: true } };
cases["valid-gpio-named"] = { env: sign(base({
    manifest: { interface: "gpio", capabilities: ["gpio"] },
    device: { interface: "gpio", default_address: "", init_args: "{trig}, {echo}",
              methods: { distance_cm: { returns: "float", params: [] } } },
    driver: { common: "volt_error_t goldtest_init(goldtest_t*d,uint8_t trig,uint8_t echo){d->trig_pin=trig;d->echo_pin=echo;pin_set_input(echo);return VOLT_OK;}\nfloat goldtest_distance_cm(goldtest_t*d){return (float)pin_read(d->echo_pin);}" },
}, {
    // header must match the gpio shape — set below
})), expect: { ok: true } };
// fix the gpio fixture's header (over-merge doesn't reach header)
cases["valid-gpio-named"].env.header = { struct_name: "goldtest_t",
    fields: [["trig_pin", "uint8_t"], ["echo_pin", "uint8_t"]],
    init_params: [["trig", "uint8_t"], ["echo", "uint8_t"]],
    methods: [{ name: "distance_cm", ret: "float", params: [] }] };
sign(cases["valid-gpio-named"].env);
cases["declared-network"] = { env: sign(base({
    manifest: { capabilities: ["i2c", "network"] },
    driver: { common: "volt_error_t goldtest_init(goldtest_t*d,uint8_t bus_id,uint8_t addr){d->bus_id=bus_id;d->addr=addr;return VOLT_OK;}\nfloat goldtest_read(goldtest_t*d){volt_wifi_connect();return 0;}" },
})), expect: { ok: true } };

// --- should FAIL at VERIFY ---
const tampered = sign(base()); tampered.driver.common += "// evil";  // change after signing
cases["tampered"] = { env: tampered, expect: { ok: false, stage: "verify" } };
const forged = base(); forged.hash = "sha256:0"; forged.signature = "ed25519:" + Buffer.alloc(64).toString("base64");
cases["forged"] = { env: forged, expect: { ok: false, stage: "verify" } };
cases["wrong-schema"] = { env: sign(base({ schema: 2 })), expect: { ok: false, stage: "verify" } };
// distinct content (own version) so revoking its hash doesn't touch valid-i2c
const revoked = sign(base({ manifest: { version: "0.9.0" } }));
cases["revoked"] = { env: revoked, expect: { ok: false, stage: "verify" }, revoke: revoked.hash };

// --- should FAIL at VALIDATE ---
cases["inject-initargs"] = { env: sign(base({ device: { init_args: "{addr.__class__}" } })), expect: { ok: false, stage: "validate" } };
cases["forbidden-system"] = { env: sign(base({ driver: { common: "int x(){return system(\"rm\");}" } })), expect: { ok: false, stage: "validate" } };
cases["traversal-name"] = { env: sign(base({ device: { c_prefix: "../evil" } })), expect: { ok: false, stage: "validate" } };
cases["undeclared-network"] = { env: sign(base({ driver: { common: "float goldtest_read(goldtest_t*d){volt_wifi_connect();return 0;}" } })), expect: { ok: false, stage: "validate" } };

// write key-set (with the revoked hash) + fixtures + expected manifest
const revokedHashes = Object.values(cases).filter(c => c.revoke).map(c => c.revoke);
fs.writeFileSync(path.join(KEYS, "test-keyset.json"),
    JSON.stringify({ keys: [{ id: "test-k1", publicKeyPem: pubPem, status: "active" }], revoked: revokedHashes }, null, 2));

const expected = {};
for (const [name, c] of Object.entries(cases)) {
    fs.writeFileSync(path.join(FIX, name + ".vlib"), JSON.stringify(c.env, null, 2));
    expected[name] = c.expect;
}
fs.writeFileSync(path.join(FIX, "expected.json"), JSON.stringify(expected, null, 2));
console.log(`generated ${Object.keys(cases).length} fixtures + test key-set (${revokedHashes.length} revoked)`);
