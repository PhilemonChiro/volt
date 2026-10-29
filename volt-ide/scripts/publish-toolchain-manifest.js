#!/usr/bin/env node
// publish-toolchain-manifest.js — sign the toolchain manifest and publish it to R2.
//
// The manifest's source of truth is the CLI's built-in copy,
// cli/internal/toolchain/fallback-manifest.json. Toolchain files live only in
// the R2 bucket volt-dl, served at https://dl.voltembedded.com/<tag>/<file>;
// each asset's url is pointed there (upstream, the vendor's own URL, stays as
// the last-resort source). This script bumps manifest_version, signs it, checks
// the signature against the keys the CLI pins, writes the CLI copy back (so the
// binary and the published manifest are the same), and uploads manifest.json.
//
//   node scripts/publish-toolchain-manifest.js --dry-run
//   node scripts/publish-toolchain-manifest.js
//
// Key: VOLT_TOOLCHAIN_SIGNING_KEY (default ~/.volt/secrets/volt-toolchain-signing.pem).
// Uploading a new toolchain file:
//   npx wrangler r2 object put volt-dl/<tag>/<file> --file <file> --remote
// then add its sha256/size_bytes to fallback-manifest.json and run this.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const trust = require("../src/main/toolchain-trust");

const BUCKET = "volt-dl";
const BASE = "https://dl.voltembedded.com";
const dry = process.argv.includes("--dry-run");
const cliDir = path.resolve(__dirname, "..", "..", "..", "cli", "internal", "toolchain");
const manifestPath = path.join(cliDir, "fallback-manifest.json");
const keyPath = process.env.VOLT_TOOLCHAIN_SIGNING_KEY || path.join(os.homedir(), ".volt", "secrets", "volt-toolchain-signing.pem");

async function main() {
    const m = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    for (const a of Object.values(m.assets)) {
        a.url = `${BASE}/${m.tag}/${a.filename}`;
        delete a.mirrors;
    }
    // Never publish a version the CLI would treat as a rollback.
    const live = await fetch(`${BASE}/${m.tag}/manifest.json`).then(r => r.ok ? r.json() : null).catch(() => null);
    m.manifest_version = Math.max(m.manifest_version || 0, (live && live.manifest_version) || 0) + 1;
    m.generated_at = new Date().toISOString();

    const signed = trust.sign(m, fs.readFileSync(keyPath, "utf8"));
    const keyset = JSON.parse(fs.readFileSync(path.join(cliDir, "keys.json"), "utf8"));
    const v = trust.verify(signed, { keyset });
    if (!v.ok) throw new Error(`signature check failed: ${v.reason || "unknown"}`);

    const text = JSON.stringify(signed, null, 2) + "\n";
    console.log(`manifest_version ${signed.manifest_version}, ${Object.keys(signed.assets).length} assets, all from ${BASE}/${m.tag}/`);
    if (dry) { console.log("dry run: nothing written"); return; }
    fs.writeFileSync(manifestPath, text);
    const tmp = path.join(os.tmpdir(), `volt-manifest-${process.pid}.json`);
    fs.writeFileSync(tmp, text);
    execFileSync("npx", ["wrangler", "r2", "object", "put", `${BUCKET}/${m.tag}/manifest.json`, "--file", tmp,
        "--content-type", "application/json", "--remote"], { stdio: "inherit", cwd: path.resolve(__dirname, "..") });
    fs.rmSync(tmp);
    console.log(`published ${BASE}/${m.tag}/manifest.json — rebuild volt (npm run build:volt) so the binary carries the same manifest`);
}

main().catch(e => { console.error(e.message); process.exit(1); });
