#!/usr/bin/env node
// Publish toolchain tarballs + manifest.json to the Volt mirror release.
//
// Usage:
//   node scripts/publish-toolchains.js [--dry-run] [--only=key1,key2] [--manifest-only]
//
// For each asset in FALLBACK_MANIFEST.assets (filtered by --only):
//   1. Download the upstream tarball into /tmp/volt-mirror/<filename>
//   2. Compute SHA256 + size
//   3. Patch the in-memory manifest with computed values
//   4. Upload to GitHub release <MIRROR_TAG> on PhilemonChiro/volt-toolchains
//
// Then always (unless --dry-run):
//   - Write the patched manifest to /tmp/volt-mirror/manifest.json
//   - Upload it as a release asset (--clobber so users always get the latest)
//
// --manifest-only: skip the tarball download/upload, just regenerate +
// republish manifest.json. Useful when you've only changed metadata
// (extract format, install_to, chip_requirements, known_issues, etc.)
//
// Requires: gh CLI authenticated. Run from volt-ide/.

const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const https = require("https");
const crypto = require("crypto");

const mirror = require("../src/main/toolchain-mirror");
const trust  = require("../src/main/toolchain-trust");
const { FALLBACK_MANIFEST, MIRROR_TAG } = mirror;

const args = process.argv.slice(2);
const DRY_RUN       = args.includes("--dry-run");
const MANIFEST_ONLY = args.includes("--manifest-only");
const ONLY = (args.find(a => a.startsWith("--only=")) || "").slice(7).split(",").filter(Boolean);

// Signing: the manifest is Ed25519-signed before upload so clients can verify
// it against a pinned key (see toolchain-trust.js). The private key is read from
// --key=<path> or $VOLT_TOOLCHAIN_SIGNING_KEY and must NEVER live in the repo.
// Publishing unsigned requires the explicit --allow-unsigned escape hatch (such
// a manifest is rejected by any client that has pinned a key).
const KEY_PATH = (args.find(a => a.startsWith("--key=")) || "").slice(6)
    || process.env.VOLT_TOOLCHAIN_SIGNING_KEY || "";
const ALLOW_UNSIGNED = args.includes("--allow-unsigned");

const STAGING = path.join("/tmp", "volt-mirror");
const REPO    = "PhilemonChiro/volt-toolchains";

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
        "--notes", `Pinned toolchain tarballs + manifest.json for Volt IDE.\n\nThe IDE fetches manifest.json from this release at runtime, so toolchain\nversions can be updated without shipping a new IDE.\n\nSee TOOLCHAINS.md in the volt repo for refresh instructions.`,
        "--prerelease",
    ]);
}

function uploadAsset(tag, filePath) {
    const name = path.basename(filePath);
    if (ghReleaseAssetExists(tag, name)) {
        log(`Asset ${name} already in release — replacing`);
        if (!DRY_RUN) ghRun(["release", "delete-asset", tag, name, "--repo", REPO, "--yes"]);
    }
    if (DRY_RUN) { log(`[dry-run] would upload ${name}`); return; }
    ghRun(["release", "upload", tag, filePath, "--repo", REPO]);
}

async function publishOne(key, asset, workingManifest) {
    fs.mkdirSync(STAGING, { recursive: true });
    const filename = asset.filename || path.basename(asset.url);
    const local = path.join(STAGING, filename);

    log(`\n=== ${key} ===`);
    log(`  upstream: ${asset.upstream}`);

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

    // Patch the working manifest in-memory so the regenerated manifest.json
    // reflects the just-published artifact.
    workingManifest.assets[key] = {
        ...workingManifest.assets[key],
        sha256,
        size_bytes: sizeBytes,
    };
    log(`  Patched manifest entry for ${key}`);
}

// Sign the manifest before it is written/uploaded. Fails closed: no key and no
// --allow-unsigned => refuse to publish, rather than ship something clients will
// silently reject.
function signManifest(workingManifest) {
    if (!KEY_PATH) {
        if (ALLOW_UNSIGNED) {
            log("WARNING: publishing an UNSIGNED manifest (--allow-unsigned). Any client");
            log("         that has pinned a signing key WILL REJECT it and fall back to");
            log("         its baked-in manifest. Use only for a keyless bootstrap.");
            return workingManifest;
        }
        throw new Error("No signing key. Pass --key=<path> or set VOLT_TOOLCHAIN_SIGNING_KEY "
            + "(or --allow-unsigned to deliberately publish unsigned). See docs/toolchain-distribution.md");
    }
    const pem = fs.readFileSync(KEY_PATH, "utf-8");
    const signed = trust.sign(workingManifest, pem);
    log(`Signed manifest (manifest_version=${signed.manifest_version}, key=${path.basename(KEY_PATH)})`);
    return signed;
}

function writeManifestJson(workingManifest) {
    const out = path.join(STAGING, "manifest.json");
    fs.mkdirSync(STAGING, { recursive: true });
    fs.writeFileSync(out, JSON.stringify(signManifest(workingManifest), null, 2));
    log(`\nWrote manifest.json: ${out}`);
    return out;
}

async function main() {
    // Fail fast on a missing signing key — BEFORE downloading/uploading any
    // 280 MB tarball — rather than doing all the work then refusing at write time.
    if (!KEY_PATH && !ALLOW_UNSIGNED) {
        throw new Error("No signing key. Pass --key=<path> or set VOLT_TOOLCHAIN_SIGNING_KEY "
            + "(or --allow-unsigned to deliberately publish unsigned). See docs/toolchain-distribution.md");
    }
    if (KEY_PATH && !fs.existsSync(KEY_PATH)) {
        throw new Error(`Signing key not found at: ${KEY_PATH}`);
    }

    // Deep-clone the baked-in manifest so per-asset updates don't mutate
    // the imported FALLBACK_MANIFEST (which would leak into manifestIsCompatible
    // checks etc. while this script is running).
    const workingManifest = JSON.parse(JSON.stringify(FALLBACK_MANIFEST));

    if (!MANIFEST_ONLY) {
        const keys = Object.keys(workingManifest.assets).filter(k => ONLY.length === 0 || ONLY.includes(k));
        log(`Publishing ${keys.length} tarballs + manifest.json to ${MIRROR_TAG} (dry-run=${DRY_RUN})`);
        for (const key of keys) {
            try {
                await publishOne(key, workingManifest.assets[key], workingManifest);
            } catch (e) {
                console.error(`[publish-toolchains] FAILED ${key}: ${e.message}`);
                process.exitCode = 1;
                // Continue with other assets so a single upstream outage
                // doesn't block the rest of the publish.
            }
        }
    } else {
        log(`--manifest-only: skipping tarball downloads, will publish manifest.json only`);
    }

    const manifestPath = writeManifestJson(workingManifest);
    ensureRelease();
    uploadAsset(MIRROR_TAG, manifestPath);

    log("\nDone.");
    log(`Live manifest URL: ${mirror.MANIFEST_URL}`);
}

main().catch(e => { console.error(e); process.exit(1); });
