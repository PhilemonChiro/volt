#!/usr/bin/env node
// Publish toolchain tarballs to the Volt mirror release.
//
// Usage:
//   node scripts/publish-toolchains.js [--dry-run] [--only=key1,key2]
//
// What it does, for each entry in MANIFEST:
//   1. Downloads the upstream tarball into /tmp/volt-mirror/<key>.<ext>
//   2. Computes SHA256
//   3. Uploads to GitHub release <MIRROR_TAG> (creates the release if missing)
//   4. Patches src/main/toolchain-mirror.js with the computed sha256 + size
//
// Requires: gh CLI authenticated to the volt repo, internet, ~3 GB free.

const { execSync, spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const https = require("https");
const crypto = require("crypto");

const mirror = require("../src/main/toolchain-mirror");
const { MANIFEST, MIRROR_TAG } = mirror;

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const ONLY = (args.find(a => a.startsWith("--only=")) || "").slice(7).split(",").filter(Boolean);

const STAGING = path.join("/tmp", "volt-mirror");
const REPO    = "PhilemonChiro/volt";

function log(...a) { console.log("[publish-toolchains]", ...a); }

function downloadFile(url, dest) {
    return new Promise((resolve, reject) => {
        const out = fs.createWriteStream(dest);
        let received = 0, total = 0, lastPct = -1;
        function get(u, hops) {
            if (hops > 5) return reject(new Error("too many redirects"));
            https.get(u, (res) => {
                if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                    res.resume();
                    return get(new URL(res.headers.location, u).href, hops + 1);
                }
                if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode} for ${u}`));
                total = Number(res.headers["content-length"]) || 0;
                res.on("data", (chunk) => {
                    received += chunk.length;
                    if (total) {
                        const pct = Math.floor(received / total * 100);
                        if (pct !== lastPct && pct % 10 === 0) {
                            process.stdout.write(`  ${pct}% (${(received/1e6).toFixed(1)}/${(total/1e6).toFixed(1)} MB)\n`);
                            lastPct = pct;
                        }
                    }
                });
                res.pipe(out);
                out.on("finish", () => out.close(() => resolve()));
                out.on("error", reject);
            }).on("error", reject);
        }
        get(url, 0);
    });
}

function sha256OfFile(filePath) {
    return new Promise((resolve, reject) => {
        const h = crypto.createHash("sha256");
        const s = fs.createReadStream(filePath);
        s.on("data", (chunk) => h.update(chunk));
        s.on("end", () => resolve(h.digest("hex")));
        s.on("error", reject);
    });
}

function ghRun(args) {
    log("gh", args.join(" "));
    const r = spawnSync("gh", args, { stdio: "inherit", encoding: "utf-8" });
    if (r.status !== 0) throw new Error(`gh exited ${r.status}`);
}

function ghReleaseExists(tag) {
    const r = spawnSync("gh", ["release", "view", tag, "--repo", REPO], { encoding: "utf-8" });
    return r.status === 0;
}

function ghReleaseAssetExists(tag, filename) {
    const r = spawnSync("gh", ["release", "view", tag, "--repo", REPO, "--json", "assets"], { encoding: "utf-8" });
    if (r.status !== 0) return false;
    try {
        const data = JSON.parse(r.stdout);
        return (data.assets || []).some(a => a.name === filename);
    } catch (_) { return false; }
}

function ensureRelease() {
    if (ghReleaseExists(MIRROR_TAG)) { log(`Release ${MIRROR_TAG} exists`); return; }
    if (DRY_RUN) { log(`[dry-run] would create release ${MIRROR_TAG}`); return; }
    log(`Creating release ${MIRROR_TAG}`);
    ghRun(["release", "create", MIRROR_TAG,
        "--repo", REPO,
        "--title", `Toolchains snapshot ${MIRROR_TAG}`,
        "--notes", `Pinned toolchain tarballs for Volt IDE.\n\nMirrored from official Arm.com, Kitware, ninja-build sources.\nUsed by the IDE\\'s on-demand toolchain installer (build.toolchainSource=auto|mirror).\n\nSee TOOLCHAINS.md in the repo for refresh instructions.`,
        "--prerelease",
    ]);
}

function uploadAsset(tag, filePath) {
    const name = path.basename(filePath);
    if (ghReleaseAssetExists(tag, name)) {
        log(`Asset ${name} already in release — overwriting`);
        if (!DRY_RUN) ghRun(["release", "delete-asset", tag, name, "--repo", REPO, "--yes"]);
    }
    if (DRY_RUN) { log(`[dry-run] would upload ${name}`); return; }
    ghRun(["release", "upload", tag, filePath, "--repo", REPO]);
}

function patchManifestSha(key, sha256, sizeBytes) {
    const file = path.join(__dirname, "..", "src", "main", "toolchain-mirror.js");
    const lines = fs.readFileSync(file, "utf-8").split("\n");
    // Walk lines to find the entry that starts "<key>": {
    const entryStart = lines.findIndex(l => l.match(new RegExp(`^\\s*"${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"\\s*:\\s*{`)));
    if (entryStart < 0) {
        log(`WARN: could not locate manifest entry for ${key} — skipping patch`);
        return;
    }
    // Find the closing `},` for this entry — first line that's pure `    },`
    let entryEnd = -1;
    for (let i = entryStart + 1; i < lines.length; i++) {
        if (/^\s*},\s*$/.test(lines[i])) { entryEnd = i; break; }
    }
    if (entryEnd < 0) {
        log(`WARN: could not locate end of entry ${key} — skipping patch`);
        return;
    }
    let patched = false;
    for (let i = entryStart; i <= entryEnd; i++) {
        if (/^\s*sha256:/.test(lines[i])) {
            lines[i] = lines[i].replace(/sha256:\s*[^,]+,/, `sha256:   "${sha256}",`);
            patched = true;
        } else if (/^\s*sizeBytes:/.test(lines[i])) {
            lines[i] = lines[i].replace(/sizeBytes:\s*[^,]+,/, `sizeBytes: ${sizeBytes},`);
        }
    }
    if (!patched) { log(`WARN: no sha256 line found inside entry ${key}`); return; }
    if (DRY_RUN) { log(`[dry-run] would patch ${key} sha256=${sha256.slice(0,12)}…`); return; }
    fs.writeFileSync(file, lines.join("\n"));
    log(`Patched manifest: ${key} -> sha256 ${sha256.slice(0,16)}…`);
}

async function publishOne(key, asset) {
    fs.mkdirSync(STAGING, { recursive: true });
    const filename = path.basename(asset.mirror);
    const local = path.join(STAGING, filename);

    log(`\n=== ${key} ===`);
    log(`  upstream: ${asset.upstream}`);
    log(`  mirror:   ${asset.mirror}`);

    if (!fs.existsSync(local)) {
        log(`  Downloading…`);
        await downloadFile(asset.upstream, local);
    } else {
        log(`  Using cached: ${local}`);
    }

    const sizeBytes = fs.statSync(local).size;
    log(`  Size: ${(sizeBytes / 1e6).toFixed(1)} MB`);

    log(`  Computing SHA256…`);
    const sha256 = await sha256OfFile(local);
    log(`  SHA256: ${sha256}`);

    ensureRelease();
    uploadAsset(MIRROR_TAG, local);
    patchManifestSha(key, sha256, sizeBytes);
}

async function main() {
    const keys = Object.keys(MANIFEST).filter(k => ONLY.length === 0 || ONLY.includes(k));
    log(`Publishing ${keys.length} toolchains to ${MIRROR_TAG} (dry-run=${DRY_RUN})`);
    for (const key of keys) {
        try {
            await publishOne(key, MANIFEST[key]);
        } catch (e) {
            console.error(`[publish-toolchains] FAILED ${key}: ${e.message}`);
            process.exitCode = 1;
        }
    }
    log("Done.");
}

main().catch(e => { console.error(e); process.exit(1); });
