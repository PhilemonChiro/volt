// Canonicalization reference vectors — the cross-language interop contract.
//
// The IDE (Node) and the registry signer (Go) MUST produce byte-identical
// canonical JSON, or a Go-made signature won't verify in Node. This emits the
// exact bytes + SHA-256 our Node canonical() produces for a set of inputs
// chosen to catch the ways a naive Go impl drifts. The Go `pkg/canonical` test
// asserts it reproduces every `canonical` string here.
//
//   node test/vlib/canonical-vectors.js   # writes canonical-vectors.json
//
// Go gotchas these vectors expose:
//   * encoder.SetEscapeHTML(false) — Go escapes < > & by default; Node doesn't.
//   * recursive key sorting at EVERY object level (Go map marshal sorts; struct
//     marshal does NOT — decode into map[string]interface{} first).
//   * arrays keep insertion order; objects are sorted.
//   * non-ASCII stays UTF-8 (not \uXXXX); control chars are \uXXXX on both.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { canonical } = require("../../src/main/vlib-verify.js");

const inputs = [
    { note: "key sort", value: { b: 1, a: 2, c: 3 } },
    { note: "nested sort", value: { z: { y: 1, x: 2 }, a: [3, 1, 2] } },
    { note: "array order preserved", value: [3, 1, 2, { b: 1, a: 2 }] },
    { note: "HTML-special chars (must NOT be \\u-escaped)", value: { s: "a<b>&c\"d" } },
    { note: "unicode kept as UTF-8", value: { s: "café — °C ↻" } },
    { note: "control char escaped", value: { s: "tab\tnewline\n" } },
    { note: "scalars", value: { i: 42, z: 0, t: true, f: false, n: null, s: "" } },
    { note: "vlib signed-content shape", value: {
        manifest: { name: "BMP280", prefix: "bmp280", version: "1.2.0", interface: "i2c",
                    capabilities: ["i2c"], author: "gh:alice", trustTier: "verified" },
        device: { name: "BMP280", category: "sensor", interface: "i2c", default_address: "0x76",
                  c_prefix: "bmp280", c_source: "driver.c", init_args: "{bus_id}, {addr}",
                  methods: { pressure: { returns: "float", params: [] } } },
        driver: { common: "float bmp280_pressure(bmp280_t*d){return 0;}" },
        header: { struct_name: "bmp280_t", fields: [["bus_id", "uint8_t"], ["addr", "uint8_t"]],
                  init_params: [["bus_id", "uint8_t"], ["addr", "uint8_t"]],
                  methods: [{ name: "pressure", ret: "float", params: [] }] },
    } },
];

const vectors = inputs.map(({ note, value }) => {
    const c = canonical(value);
    return { note, input: value, canonical: c, sha256: crypto.createHash("sha256").update(c, "utf8").digest("hex") };
});

fs.writeFileSync(path.join(__dirname, "canonical-vectors.json"), JSON.stringify(vectors, null, 2) + "\n");
console.log(`wrote ${vectors.length} canonical vectors`);
for (const v of vectors) console.log(`  ${v.sha256.slice(0, 12)}…  ${v.note}`);
