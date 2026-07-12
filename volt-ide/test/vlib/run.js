// Golden .vlib corpus runner — asserts the IDE importer reaches the expected
// verdict on every fixture. The registry's Go pre-screen must produce identical
// verdicts on the same fixtures (the anti-drift contract). Exits non-zero on any
// mismatch so it can gate CI.
//
//   node test/vlib/gen.js && node test/vlib/run.js

const fs = require("fs");
const path = require("path");
const imp = require("../../src/main/vlib-import.js");

const FIX = path.join(__dirname, "fixtures");
const KEYS = path.join(__dirname, "keys", "test-keyset.json");

const expected = JSON.parse(fs.readFileSync(path.join(FIX, "expected.json"), "utf-8"));
let pass = 0, fail = 0;

for (const [name, exp] of Object.entries(expected)) {
    const env = JSON.parse(fs.readFileSync(path.join(FIX, name + ".vlib"), "utf-8"));
    const r = imp.inspect(env, { keysPath: KEYS });
    const okMatch = r.ok === exp.ok;
    const stageMatch = exp.ok ? true : (r.stage === exp.stage);
    const good = okMatch && stageMatch;
    if (good) { pass++; console.log("PASS ", name); }
    else {
        fail++;
        console.log("FAIL ", name, `— expected ${JSON.stringify(exp)}, got ok=${r.ok} stage=${r.stage} reason=${r.reason || (r.errors || [])[0] || ""}`);
    }
}

console.log(`\n${pass}/${pass + fail} fixtures passed`);
process.exit(fail ? 1 : 0);
