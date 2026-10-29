#!/usr/bin/env node
// publish-official.js — submit Volt's official device libraries to the Grid.
//
// Reads the reserved (official) names from the Grid source, builds each one
// from volt/devices exactly as the IDE's Publish does, and runs the Grid's
// pre-screen. With --submit it sends them; they then wait in Gate for a
// maintainer to approve each one. Grid records them as author "volt", tier
// "official" (admin submissions of reserved names).
//
//   node scripts/publish-official.js                 dry run: what would be sent
//   VOLT_TOKEN=<volt_session> node scripts/publish-official.js --submit
//
// Options: --grid <url> (default: registry.gridUrl from ~/.volt/settings.json),
// --version <x.y.z> (default 1.0.0), --only a,b,c.
//
// A library already on the Grid is skipped when its driver, descriptor and
// header spec are unchanged; otherwise it is submitted as the next patch version. On --submit,
// device.json is stamped with that version, so the IDE can tell when the Grid
// has a newer one than the copy Volt shipped.

const fs = require("fs");
const os = require("os");
const path = require("path");
const P = require("../src/main/lib-publish");

const args = process.argv.slice(2);
const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const submit = args.includes("--submit");
const version = opt("--version") || "1.0.0";
const only = opt("--only") ? new Set(opt("--only").split(",")) : null;

const repo = path.resolve(__dirname, "..", "..", "..");
const devices = path.join(repo, "volt", "devices");
const reservedGo = path.join(repo, "grid", "internal", "domain", "library", "reserved.go");

function gridUrl() {
    if (opt("--grid")) return opt("--grid").replace(/\/+$/, "");
    try { return JSON.parse(fs.readFileSync(path.join(os.homedir(), ".volt", "settings.json"), "utf8"))["registry.gridUrl"].replace(/\/+$/, ""); }
    catch (_) { throw new Error("No Grid URL: pass --grid <url>."); }
}

function reserved() {
    const m = fs.readFileSync(reservedGo, "utf8").match(/var reserved = set\(([^)]*)\)/);
    if (!m) throw new Error(`Couldn't read the reserved list from ${reservedGo}`);
    return [...m[1].matchAll(/"([^"]+)"/g)].map(x => x[1]);
}

const stable = (v) => JSON.stringify(v, (_, x) => x && typeof x === "object" && !Array.isArray(x)
    ? Object.fromEntries(Object.keys(x).sort().map(k => [k, x[k]])) : x);
const bump = (v) => v.split(".").map((n, i) => i === 2 ? Number(n) + 1 : n).join(".");
const newer = (a, b) => { const pa = a.split(".").map(Number), pb = b.split(".").map(Number); return pa[0] - pb[0] || pa[1] - pb[1] || pa[2] - pb[2]; };

// stamp records in device.json the Grid version this folder is identical to.
function stamp(dir, v) {
    const f = path.join(dir, "device.json");
    const d = JSON.parse(fs.readFileSync(f, "utf8"));
    if (d.version === v) return;
    fs.writeFileSync(f, JSON.stringify({ ...d, version: v }, null, 2) + "\n");
}

async function getJSON(url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
    const j = await r.json();
    return j.data || j;
}

async function main() {
    const grid = gridUrl();
    const token = process.env.VOLT_TOKEN || "";
    if (submit && !token) throw new Error("Set VOLT_TOKEN to your Grid session (the volt_session cookie of an admin).");
    console.log(`${submit ? "Submitting to" : "Dry run against"} ${grid}, version ${version}\n`);

    const latest = {};
    for (const c of await getJSON(`${grid}/api/v1/libraries`)) {
        if (!latest[c.prefix] || newer(c.version, latest[c.prefix]) > 0) latest[c.prefix] = c.version;
    }
    const counts = { ok: 0, skipped: 0, failed: 0 };
    for (const name of reserved()) {
        if (only && !only.has(name)) continue;
        const dir = path.join(devices, name);
        const line = (mark, msg) => console.log(`${mark} ${name.padEnd(10)} ${msg}`);
        if (!fs.existsSync(path.join(dir, "device.json"))) { line("-", "not in volt/devices"); counts.skipped++; continue; }
        const device = JSON.parse(fs.readFileSync(path.join(dir, "device.json"), "utf8"));
        const prefix = String(device.c_prefix || name).toLowerCase();
        // A variant (LCD16x2, DHT22) shares another library's driver; the Grid
        // keys libraries by prefix, so it can't be its own library yet.
        if (prefix !== name) { line("-", `variant of ${prefix} — not published separately`); counts.skipped++; continue; }
        try {
            let v = version;
            if (latest[name]) {
                const pub = await getJSON(`${grid}/api/v1/libraries/${name}/${latest[name]}/download`);
                const mine = P.build(dir, { version: latest[name], description: device.description || "" }).submission;
                const bare = (d) => { const { version: _, ...rest } = d || {}; return stable(rest); };
                const same = (pub.driver && pub.driver.common) === mine.driver.common && bare(pub.device) === bare(mine.device)
                    && stable(pub.header) === stable(mine.header);
                if (same) {
                    if (submit && device.version !== latest[name]) stamp(dir, latest[name]);
                    line("=", `already on the Grid as v${latest[name]}, unchanged`); counts.skipped++; continue;
                }
                v = bump(latest[name]);
            }
            const res = await P.check(grid, dir, { version: v, description: device.description || "" });
            if (res.errors.length) { line("✗", res.errors[0]); counts.failed++; continue; }
            if (!submit) { line("✓", `v${v} passes · capabilities ${res.capabilities.join(", ")}${latest[name] ? ` (changed since v${latest[name]})` : ""}`); counts.ok++; continue; }
            stamp(dir, v);
            const r = await P.submit(grid, token, P.build(dir, { version: v, description: device.description || "", capabilities: res.capabilities }).submission);
            line("✓", `v${v} submitted — ${r.status || "pending"}`); counts.ok++;
        } catch (e) { line("✗", e.message); counts.failed++; }
    }
    console.log(`\n${counts.ok} ${submit ? "submitted" : "ready"}, ${counts.skipped} skipped, ${counts.failed} failed`);
    if (submit && counts.ok) console.log("Approve them in Gate → Queue.");
    process.exitCode = counts.failed ? 1 : 0;
}

main().catch(e => { console.error(e.message); process.exit(1); });
