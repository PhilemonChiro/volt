// Vendored toolchain mirror — gives Volt IDE deterministic control over
// which compiler / SDK versions ship with each release.
//
// Strategy:
//   - Each binary toolchain (ARM GCC, cmake, ninja, ...) is mirrored as a
//     release asset on the Volt repo: github.com/PhilemonChiro/volt/releases
//     /download/<MIRROR_TAG>/<filename>
//   - Manifest below records the upstream URL, mirror URL, and SHA256.
//   - downloadAsset() tries mirror first (fast, version-pinned, controlled),
//     falls back to upstream (resilience). Verifies SHA256 either way.
//   - Settings: build.toolchainSource = "auto" (default) | "mirror" | "upstream"
//
// To refresh the mirror with a new version:
//   1. Update the manifest below (urls + leave sha256 as null for new entries).
//   2. Run `npm run publish:toolchains` — downloads from upstream, computes
//      sha256, uploads to <MIRROR_TAG> release, writes hashes back into this
//      file.
//   3. Commit the updated manifest and ship.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const https = require("https");

const MIRROR_TAG = "toolchains-2026.05";
const MIRROR_BASE = `https://github.com/PhilemonChiro/volt/releases/download/${MIRROR_TAG}`;

// Each asset has:
//   upstream  — official source URL (Arm.com, Kitware, ninja-build, etc.)
//   mirror    — our GitHub release URL (filename normalized)
//   sha256    — hex digest, null until populated by publish-toolchains.js
//   sizeBytes — for progress display; null is OK
const MANIFEST = {
    "arm-gnu-toolchain-13.2-darwin-arm64": {
        upstream: "https://developer.arm.com/-/media/Files/downloads/gnu/13.2.rel1/binrel/arm-gnu-toolchain-13.2.rel1-darwin-arm64-arm-none-eabi.tar.xz",
        mirror:   `${MIRROR_BASE}/arm-gnu-toolchain-13.2-darwin-arm64.tar.xz`,
        sha256:   "39c44f8af42695b7b871df42e346c09fee670ea8dfc11f17083e296ea2b0d279",
        sizeBytes: 129557320,
    },
    "arm-gnu-toolchain-13.2-darwin-x86_64": {
        upstream: "https://developer.arm.com/-/media/Files/downloads/gnu/13.2.rel1/binrel/arm-gnu-toolchain-13.2.rel1-darwin-x86_64-arm-none-eabi.tar.xz",
        mirror:   `${MIRROR_BASE}/arm-gnu-toolchain-13.2-darwin-x86_64.tar.xz`,
        sha256:   "075faa4f3e8eb45e59144858202351a28706f54a6ec17eedd88c9fb9412372cc",
        sizeBytes: 139345848,
    },
    "arm-gnu-toolchain-13.2-linux-x64": {
        upstream: "https://developer.arm.com/-/media/Files/downloads/gnu/13.2.rel1/binrel/arm-gnu-toolchain-13.2.rel1-x86_64-arm-none-eabi.tar.xz",
        mirror:   `${MIRROR_BASE}/arm-gnu-toolchain-13.2-linux-x64.tar.xz`,
        sha256:   "6cd1bbc1d9ae57312bcd169ae283153a9572bd6a8e4eeae2fedfbc33b115fdbb",
        sizeBytes: 179347712,
    },
    "cmake-3.30.5-macos-universal": {
        upstream: "https://github.com/Kitware/CMake/releases/download/v3.30.5/cmake-3.30.5-macos-universal.tar.gz",
        mirror:   `${MIRROR_BASE}/cmake-3.30.5-macos-universal.tar.gz`,
        sha256:   "3d603e507c7579b13518ef752b4ffcf3ed479fba80ee171d7d85da8153e869d0",
        sizeBytes: 76493076,
    },
    "ninja-1.12.1-mac": {
        upstream: "https://github.com/ninja-build/ninja/releases/download/v1.12.1/ninja-mac.zip",
        mirror:   `${MIRROR_BASE}/ninja-1.12.1-mac.zip`,
        sha256:   "89a287444b5b3e98f88a945afa50ce937b8ffd1dcc59c555ad9b1baf855298c9",
        sizeBytes: 281130,
    },
};

function downloadFile(url, dest) {
    return new Promise((resolve, reject) => {
        const out = fs.createWriteStream(dest);
        function get(u, hops) {
            if (hops > 5) return reject(new Error("too many redirects"));
            https.get(u, (res) => {
                if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                    res.resume();
                    return get(new URL(res.headers.location, u).href, hops + 1);
                }
                if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode} for ${u}`));
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

// Pick sources to try based on the user's "build.toolchainSource" setting.
// auto     — mirror first, fall back to upstream
// mirror   — mirror only (fail if mirror is down or asset not mirrored)
// upstream — upstream only (skips mirror)
function sourcesFor(asset, preference) {
    if (preference === "upstream") return [{ url: asset.upstream, label: "upstream" }];
    if (preference === "mirror")   return [{ url: asset.mirror,   label: "Volt mirror" }];
    // auto: mirror first, then upstream
    return [
        { url: asset.mirror,   label: "Volt mirror" },
        { url: asset.upstream, label: "upstream" },
    ];
}

// Download an asset by key with optional SHA256 verification and source
// fallback. Returns true on success, false on all-sources failure.
// emit.log is called with status messages; emit.progress (optional) gets
// percentage + detail strings during the download.
async function downloadAsset(key, destPath, emit, preference = "auto") {
    const asset = MANIFEST[key];
    if (!asset) throw new Error(`Unknown toolchain asset: ${key}`);
    const sources = sourcesFor(asset, preference);

    for (const src of sources) {
        if (!src.url) continue;
        try {
            emit?.log?.(`Downloading from ${src.label}…`);
            await downloadFile(src.url, destPath);
            if (asset.sha256) {
                emit?.log?.("Verifying SHA256…");
                const h = await sha256OfFile(destPath);
                if (h !== asset.sha256) {
                    emit?.log?.(`SHA256 mismatch on ${src.label} (got ${h.slice(0,16)}…, expected ${asset.sha256.slice(0,16)}…)`);
                    try { fs.unlinkSync(destPath); } catch (_) {}
                    continue;
                }
                emit?.log?.(`Verified: ${asset.sha256.slice(0,16)}…`);
            } else {
                emit?.log?.(`Downloaded (no sha256 pinned yet for ${key})`);
            }
            return true;
        } catch (e) {
            emit?.log?.(`${src.label} failed: ${e.message}`);
            try { fs.unlinkSync(destPath); } catch (_) {}
        }
    }
    return false;
}

// Read the user's preference from settings (defaults to "auto").
function getPreference() {
    try {
        const s = require("./settings");
        const v = s.get("build.toolchainSource");
        if (v === "mirror" || v === "upstream") return v;
    } catch (_) {}
    return "auto";
}

module.exports = {
    MIRROR_TAG, MIRROR_BASE, MANIFEST,
    downloadAsset, sha256OfFile, getPreference,
};
