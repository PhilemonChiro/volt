# Golden `.vlib` corpus — the IDE ↔ registry contract

This is the **shared correctness contract** between the Volt IDE importer
(`src/main/vlib-verify.js` + `vlib-import.js`, JavaScript) and the future
registry pre-screen (`registry-api/pkg/...`, Go). Both must reach the **same
verdict** on every fixture here — otherwise they've drifted, and the registry
could sign something the IDE rejects (annoying) or the IDE could trust something
the registry would have caught (dangerous).

```
node test/vlib/gen.js   # (re)generate signed fixtures + a TEST key-set
node test/vlib/run.js   # assert the importer's verdict on each fixture
npm run test:vlib       # both
```

`run.js` exits non-zero on any mismatch — wire it into CI.

## Fixtures

| Fixture | Expected verdict | Guards |
|---|---|---|
| `valid-i2c` | ok | happy path (I²C) |
| `valid-gpio-named` | ok | happy path (GPIO named pins) |
| `declared-network` | ok | capability declared → allowed |
| `tampered` | reject @ verify | payload changed after signing |
| `forged` | reject @ verify | bad signature |
| `wrong-schema` | reject @ verify | unknown envelope schema |
| `revoked` | reject @ verify | content hash on the revocation list |
| `inject-initargs` | reject @ validate | `str.format` / template injection |
| `forbidden-system` | reject @ validate | `system()` / RCE construct |
| `traversal-name` | reject @ validate | `../` in device name |
| `undeclared-network` | reject @ validate | uses network APIs without the capability |

## For the Go side

When you build the registry pre-screen, copy the `.vlib` files into its test
suite and assert identical verdicts. The `keys/test-keyset.json` holds a
**throwaway** test key — the real registry key lives only in
`src/main/registry-keys.json` on the IDE side (public) and the Go signer (private).

### Canonicalization contract (the #1 interop risk)

A Go-made signature only verifies in Node if both produce **byte-identical**
canonical JSON. `canonical-vectors.json` (from `node test/vlib/canonical-vectors.js`)
is the reference: `{ input, canonical, sha256 }` for each case. The Go
`pkg/canonical` must reproduce every `canonical` string exactly.

The algorithm (matches `vlib-verify.js` `canonical()`):
- Decode into a generic value first (`map[string]interface{}` / `[]interface{}`) —
  **struct** marshaling won't sort keys; map marshaling does.
- **Sort object keys** at every level; **preserve array order**.
- **`encoder.SetEscapeHTML(false)`** — Go escapes `< > &` by default, Node doesn't.
  (See the `HTML-special chars` vector: expected `{"s":"a<b>&c\"d"}`.)
- Non-ASCII stays UTF-8 (not `\uXXXX`); control chars are `\uXXXX` on both.
- Compact (no spaces).

Signed content = `canonical({manifest, device, driver, header})`. Then
`hash = "sha256:"+hex(sha256(bytes))` and `signature = "ed25519:"+base64(ed25519.Sign(priv, bytes))`.
Ed25519 signs the message directly (no pre-hash) — pass the canonical bytes to
`ed25519.Sign`, exactly as Node's `crypto.sign(null, bytes, key)` does.

A Go table-test over `canonical-vectors.json` proves the canonicalizer; then a
round-trip test (Go signs → this repo's `vlib-verify.js` verifies) proves the
whole signer. Do both on a machine with Go installed — Go isn't on the IDE dev box.
