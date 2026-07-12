// Vendored toolchain mirror — gives Volt IDE deterministic control over
// which compiler / SDK versions ship with each release.
//
// Architecture:
//   - manifest.json lives on the volt-toolchains release. The IDE fetches it
//     on first use and caches to ~/.volt/cache/manifest.json with a 24h TTL.
//   - If the fetch fails (offline, GitHub down) we use FALLBACK_MANIFEST
//     baked into this file. The fallback is also what the publisher writes
//     to manifest.json — so the two are always in sync at IDE release time.
//   - To roll out a new toolchain version, edit FALLBACK_MANIFEST, run
//     `npm run publish:toolchains`. That uploads the tarballs AND uploads
//     a regenerated manifest.json. Users running an older IDE pick up the
//     new versions on next build — no IDE update required.
//   - Settings: build.toolchainSource = "auto" | "mirror" | "upstream"

const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const https = require("https");
const trust = require("./toolchain-trust");

const MIRROR_TAG     = "toolchains-2026.05";
const MIRROR_BASE    = `https://github.com/PhilemonChiro/volt-toolchains/releases/download/${MIRROR_TAG}`;
const MANIFEST_URL   = `${MIRROR_BASE}/manifest.json`;
const CACHE_PATH     = path.join(os.homedir(), ".volt", "cache", "manifest.json");
// Highest manifest_version we've ever accepted — persisted so a later fetch
// can't silently roll us back to an older (signed-but-vulnerable) manifest.
const VERSION_PATH   = path.join(os.homedir(), ".volt", "cache", "manifest-version");
const CACHE_TTL_MS   = 24 * 60 * 60 * 1000; // 24h

// Baked-in default — used when the remote fetch fails (first run offline,
// GitHub outage, etc.). Mirrors what the publisher writes to manifest.json.
//
// Schema (v1):
//   schema_version  — bump when manifest shape changes
//   tag             — the volt-toolchains release tag
//   min_ide_version — IDE refuses manifests it's too old to understand
//   assets[key]:
//     filename, url, upstream, sha256, size_bytes, version
//     extract: { format: "tar.xz" | "tar.gz" | "zip", strip_components }
//     install_to: subdir under ~/.volt/toolchains
//     exposes:   command-name → relative path inside install_to
//     kind:      "compiler" | "build-system" | "sdk" | ...
//   chip_requirements[chip][platform] — list of asset keys to install
//   known_issues — [{ platform, min_macos?, asset, note }]
const FALLBACK_MANIFEST = {
    schema_version: 1,
    tag: MIRROR_TAG,
    // Monotonic counter, bumped on every publish. The client refuses any
    // fetched manifest whose version is below the highest it has accepted, so a
    // replay of an older signed manifest can't downgrade the pinned toolchains.
    manifest_version: 1,
    min_ide_version: "2.0.10",
    assets: {
        "arm-gnu-toolchain-13.2-darwin-arm64": {
            filename:   "arm-gnu-toolchain-13.2-darwin-arm64.tar.xz",
            url:        `${MIRROR_BASE}/arm-gnu-toolchain-13.2-darwin-arm64.tar.xz`,
            upstream:   "https://developer.arm.com/-/media/Files/downloads/gnu/13.2.rel1/binrel/arm-gnu-toolchain-13.2.rel1-darwin-arm64-arm-none-eabi.tar.xz",
            sha256:     "39c44f8af42695b7b871df42e346c09fee670ea8dfc11f17083e296ea2b0d279",
            size_bytes: 129557320,
            extract:    { format: "tar.xz", strip_components: 1 },
            install_to: "arm-gnu-toolchain",
            exposes:    { "arm-none-eabi-gcc": "bin/arm-none-eabi-gcc" },
            kind:       "compiler",
            version:    "13.2.rel1",
        },
        "arm-gnu-toolchain-13.2-darwin-x86_64": {
            filename:   "arm-gnu-toolchain-13.2-darwin-x86_64.tar.xz",
            url:        `${MIRROR_BASE}/arm-gnu-toolchain-13.2-darwin-x86_64.tar.xz`,
            upstream:   "https://developer.arm.com/-/media/Files/downloads/gnu/13.2.rel1/binrel/arm-gnu-toolchain-13.2.rel1-darwin-x86_64-arm-none-eabi.tar.xz",
            sha256:     "075faa4f3e8eb45e59144858202351a28706f54a6ec17eedd88c9fb9412372cc",
            size_bytes: 139345848,
            extract:    { format: "tar.xz", strip_components: 1 },
            install_to: "arm-gnu-toolchain",
            exposes:    { "arm-none-eabi-gcc": "bin/arm-none-eabi-gcc" },
            kind:       "compiler",
            version:    "13.2.rel1",
        },
        "arm-gnu-toolchain-13.2-linux-x64": {
            filename:   "arm-gnu-toolchain-13.2-linux-x64.tar.xz",
            url:        `${MIRROR_BASE}/arm-gnu-toolchain-13.2-linux-x64.tar.xz`,
            upstream:   "https://developer.arm.com/-/media/Files/downloads/gnu/13.2.rel1/binrel/arm-gnu-toolchain-13.2.rel1-x86_64-arm-none-eabi.tar.xz",
            sha256:     "6cd1bbc1d9ae57312bcd169ae283153a9572bd6a8e4eeae2fedfbc33b115fdbb",
            size_bytes: 179347712,
            extract:    { format: "tar.xz", strip_components: 1 },
            install_to: "arm-gnu-toolchain",
            exposes:    { "arm-none-eabi-gcc": "bin/arm-none-eabi-gcc" },
            kind:       "compiler",
            version:    "13.2.rel1",
        },
        "cmake-3.30.5-macos-universal": {
            filename:   "cmake-3.30.5-macos-universal.tar.gz",
            url:        `${MIRROR_BASE}/cmake-3.30.5-macos-universal.tar.gz`,
            upstream:   "https://github.com/Kitware/CMake/releases/download/v3.30.5/cmake-3.30.5-macos-universal.tar.gz",
            sha256:     "3d603e507c7579b13518ef752b4ffcf3ed479fba80ee171d7d85da8153e869d0",
            size_bytes: 76493076,
            extract:    { format: "tar.gz", strip_components: 1 },
            install_to: "cmake",
            exposes:    { "cmake": "CMake.app/Contents/bin/cmake" },
            kind:       "build-system",
            version:    "3.30.5",
        },
        "ninja-1.12.1-mac": {
            filename:   "ninja-1.12.1-mac.zip",
            url:        `${MIRROR_BASE}/ninja-1.12.1-mac.zip`,
            upstream:   "https://github.com/ninja-build/ninja/releases/download/v1.12.1/ninja-mac.zip",
            sha256:     "89a287444b5b3e98f88a945afa50ce937b8ffd1dcc59c555ad9b1baf855298c9",
            size_bytes: 281130,
            extract:    { format: "zip", strip_components: 0 },
            install_to: "ninja",
            exposes:    { "ninja": "ninja" },
            kind:       "build-system",
            version:    "1.12.1",
        },
        // picotool — direct-USB RP2040 flashing. Built from
        // github.com/raspberrypi/picotool (no official prebuilts upstream),
        // bundled with libusb-1.0 alongside, install_name/RPATH rewritten
        // to look in ./lib next to the binary. ~750-870 KB per platform.
        "picotool-2.1-darwin-arm64": {
            filename:   "picotool-2.1-darwin-arm64.tar.gz",
            url:        `${MIRROR_BASE}/picotool-2.1-darwin-arm64.tar.gz`,
            upstream:   "https://github.com/raspberrypi/picotool/releases/tag/2.1.0",
            sha256:     "b8df42935a0ee2a73ae8aa40d9c1b66112f07f1c640e567743a5ff9d64a885ef",
            size_bytes: 750994,
            extract:    { format: "tar.gz", strip_components: 0 },
            install_to: "picotool",
            exposes:    { "picotool": "picotool" },
            kind:       "flash-tool",
            version:    "2.1.0",
        },
        "picotool-2.1-linux-x64": {
            filename:   "picotool-2.1-linux-x64.tar.gz",
            url:        `${MIRROR_BASE}/picotool-2.1-linux-x64.tar.gz`,
            upstream:   "https://github.com/raspberrypi/picotool/releases/tag/2.1.0",
            sha256:     "016ff925a9e1284219e56252d43cf43c036f8b4278c8930b31fc8d8fc6e708cc",
            size_bytes: 864086,
            extract:    { format: "tar.gz", strip_components: 0 },
            install_to: "picotool",
            exposes:    { "picotool": "picotool" },
            kind:       "flash-tool",
            version:    "2.1.0",
        },
    },
    chip_requirements: {
        rp2040: {
            "darwin-arm64":  ["arm-gnu-toolchain-13.2-darwin-arm64", "cmake-3.30.5-macos-universal", "ninja-1.12.1-mac", "picotool-2.1-darwin-arm64"],
            "darwin-x86_64": ["arm-gnu-toolchain-13.2-darwin-x86_64", "cmake-3.30.5-macos-universal", "ninja-1.12.1-mac"], // picotool darwin-x86_64 not yet built
            "linux-x64":     ["picotool-2.1-linux-x64"], // apt handles gcc/cmake/ninja; picotool isn't packaged there
        },
        esp32: {
            "darwin-arm64":  ["cmake-3.30.5-macos-universal", "ninja-1.12.1-mac"],
            "darwin-x86_64": ["cmake-3.30.5-macos-universal", "ninja-1.12.1-mac"],
            "linux-x64":     [],
        },
        stm32f103: {
            "darwin-arm64":  ["arm-gnu-toolchain-13.2-darwin-arm64"],
            "darwin-x86_64": ["arm-gnu-toolchain-13.2-darwin-x86_64"],
            "linux-x64":     [],
        },
    },
    known_issues: [],
};

// ============================================================
// HTTP + crypto helpers
// ============================================================
function httpGetJson(url, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
        const req = https.get(url, { timeout: timeoutMs }, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                res.resume();
                return httpGetJson(new URL(res.headers.location, url).href, timeoutMs).then(resolve, reject);
            }
            if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
            let body = "";
            res.setEncoding("utf-8");
            res.on("data", (c) => body += c);
            res.on("end", () => {
                try { resolve(JSON.parse(body)); }
                catch (e) { reject(new Error(`Invalid JSON from ${url}: ${e.message}`)); }
            });
        });
        req.on("timeout", () => { req.destroy(new Error("timeout")); });
        req.on("error", reject);
    });
}

// Format bytes for human display. Matches `[\d.]+[KMG]?` so it's picked up
// by makeEmit's curl-progress regex (see toolchain.js).
function humanSize(bytes) {
    if (bytes >= 1e9) return (bytes / 1e9).toFixed(1) + "G";
    if (bytes >= 1e6) return (bytes / 1e6).toFixed(1) + "M";
    if (bytes >= 1e3) return (bytes / 1e3).toFixed(1) + "K";
    return bytes + "B";
}

// Download with optional progress callback. onProgress is called at most
// every ~200ms with (received, total) byte counts. total may be 0 if the
// server didn't send Content-Length.
function downloadFile(url, dest, onProgress) {
    return new Promise((resolve, reject) => {
        const out = fs.createWriteStream(dest);
        let received = 0, total = 0, lastEmit = 0;
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
                    if (!onProgress) return;
                    const now = Date.now();
                    if (now - lastEmit < 200) return;
                    lastEmit = now;
                    onProgress(received, total);
                });
                res.pipe(out);
                out.on("finish", () => {
                    if (onProgress) onProgress(received, total);
                    out.close(() => resolve());
                });
                out.on("error", reject);
            }).on("error", reject);
        }
        get(url, 0);
    });
}

// SHA256 with optional progress callback. Throttled to ~200ms.
function sha256OfFile(filePath, onProgress) {
    return new Promise((resolve, reject) => {
        const h = crypto.createHash("sha256");
        const s = fs.createReadStream(filePath);
        let total = 0;
        try { total = fs.statSync(filePath).size; } catch (_) {}
        let read = 0, lastEmit = 0;
        s.on("data", (chunk) => {
            h.update(chunk);
            read += chunk.length;
            if (!onProgress) return;
            const now = Date.now();
            if (now - lastEmit < 200) return;
            lastEmit = now;
            onProgress(read, total);
        });
        s.on("end", () => resolve(h.digest("hex")));
        s.on("error", reject);
    });
}

// ============================================================
// Manifest loading
// ============================================================

// Compare two semver-ish strings ("2.0.10" vs "2.0.12"). Returns -1/0/1.
function semverCompare(a, b) {
    const pa = String(a).split(".").map(n => parseInt(n, 10) || 0);
    const pb = String(b).split(".").map(n => parseInt(n, 10) || 0);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const x = pa[i] || 0, y = pb[i] || 0;
        if (x !== y) return x < y ? -1 : 1;
    }
    return 0;
}

function ideVersion() {
    try { return require("../../package.json").version; }
    catch (_) { return "0.0.0"; }
}

function manifestIsCompatible(m) {
    if (!m || typeof m !== "object") return false;
    if (m.schema_version !== 1) return false;
    if (m.min_ide_version && semverCompare(ideVersion(), m.min_ide_version) < 0) return false;
    if (!m.assets || typeof m.assets !== "object") return false;
    return true;
}

// Rollback floor: the highest manifest_version we've ever accepted. Persisted
// so a replayed older (signed-but-vulnerable) manifest can't downgrade us.
function rollbackFloor() {
    try { return parseInt(fs.readFileSync(VERSION_PATH, "utf-8"), 10) || 0; }
    catch (_) { return 0; }
}
function recordVersion(n) {
    try {
        fs.mkdirSync(path.dirname(VERSION_PATH), { recursive: true });
        if (n > rollbackFloor()) fs.writeFileSync(VERSION_PATH, String(n));
    } catch (_) {}
}

// A manifest that did NOT ship inside the signed app (i.e. anything from the
// network or the on-disk cache) must be Ed25519-verified against a pinned key
// AND be at or above the rollback floor. Fails closed. Returns { ok, reason }.
function isTrusted(m) {
    const v = trust.verify(m);
    if (!v.ok) return { ok: false, reason: v.reason };
    const ver = Number(m.manifest_version || 0);
    const floor = rollbackFloor();
    if (ver < floor) return { ok: false, reason: `rollback: v${ver} < accepted v${floor}` };
    return { ok: true };
}

// Cached manifest in-memory for the duration of the process so we don't
// re-fetch on every download.
let _manifestPromise = null;

function loadManifest(opts = {}) {
    if (_manifestPromise && !opts.force) return _manifestPromise;
    _manifestPromise = (async () => {
        // 1. Fresh disk cache (within TTL). Only ever written after a successful
        //    verify, but re-verify anyway — cheap, and defends on-disk tampering.
        try {
            const st = fs.statSync(CACHE_PATH);
            if (Date.now() - st.mtimeMs < CACHE_TTL_MS) {
                const m = JSON.parse(fs.readFileSync(CACHE_PATH, "utf-8"));
                if (manifestIsCompatible(m) && isTrusted(m).ok) return { manifest: m, source: "cache" };
            }
        } catch (_) {}

        // 2. Remote fetch — must be signature-verified before we trust or cache it.
        try {
            const m = await httpGetJson(MANIFEST_URL);
            if (manifestIsCompatible(m) && isTrusted(m).ok) {
                try {
                    fs.mkdirSync(path.dirname(CACHE_PATH), { recursive: true });
                    fs.writeFileSync(CACHE_PATH, JSON.stringify(m, null, 2));
                    recordVersion(Number(m.manifest_version || 0));
                } catch (_) {}
                return { manifest: m, source: "remote" };
            }
            // Fetched but untrusted (unsigned / bad sig / rolled back) => discard
            // and fall through to fallback. The caller logs the source so the
            // user still sees the toolchains install from the baked-in manifest.
        } catch (_) {}

        // 3. Stale cache (TTL expired) — still must verify.
        try {
            const m = JSON.parse(fs.readFileSync(CACHE_PATH, "utf-8"));
            if (manifestIsCompatible(m) && isTrusted(m).ok) return { manifest: m, source: "cache-stale" };
        } catch (_) {}

        // 4. Hard fallback: baked-in. Trusted implicitly — it shipped inside the
        //    code-signed app bundle, so it carries and needs no signature.
        return { manifest: FALLBACK_MANIFEST, source: "fallback" };
    })();
    return _manifestPromise;
}

// ============================================================
// Asset download with source preference + SHA256 verification
// ============================================================
// Build the ordered list of URLs to try for an asset. Because every downloaded
// tarball is SHA256-checked against the (now signed) manifest, every mirror is
// equally untrusted — so failover between them is free and safe. Optional
// asset.mirrors[] (extra CDN URLs) are tried after the primary Volt mirror and
// before the original upstream.
function sourcesFor(asset, preference) {
    const primary  = asset.url      ? [{ url: asset.url, label: "Volt mirror" }] : [];
    const mirrors  = Array.isArray(asset.mirrors)
        ? asset.mirrors.filter(Boolean).map((u, i) => ({ url: u, label: `mirror ${i + 1}` }))
        : [];
    const upstream = asset.upstream ? [{ url: asset.upstream, label: "upstream" }] : [];

    if (preference === "upstream") return upstream;
    if (preference === "mirror")   return [...primary, ...mirrors];
    return [...primary, ...mirrors, ...upstream];
}

// Download an asset by key. Returns true on success.
// Resolves the asset definition through loadManifest() so callers always
// get the latest published version (not whatever was baked into the IDE).
//
// Progress reporting:
// - We don't call emit.progress directly (that requires a stageId and we
//   don't know what stage we're inside). Instead we log lines that match
//   makeEmit's existing curl-style auto-detect regex
//   (`(\d+)%\s+([\d.]+[KMG]?)\s*/\s*([\d.]+[KMG]?)`) — makeEmit picks
//   them up and forwards as stage_progress events to the renderer.
async function downloadAsset(key, destPath, emit, preference = "auto") {
    const { manifest, source } = await loadManifest();
    const asset = manifest.assets?.[key];
    if (!asset) throw new Error(`Unknown toolchain asset: ${key} (manifest source=${source})`);

    if (source !== "remote" && source !== "cache") {
        emit?.log?.(`Using ${source} manifest (could not fetch live)`);
    }

    // Progress callback for both download and SHA256 verify. Falls back to
    // the asset's recorded size_bytes when the server doesn't send a
    // Content-Length header.
    const expected = asset.size_bytes || 0;
    function makeProgressLogger(label) {
        return (current, total) => {
            const denom = total || expected;
            if (!denom) return;
            const pct = Math.min(100, Math.floor(current / denom * 100));
            // Format the auto-detect regex needs:  " 45%  130.5M/280.0M"
            emit?.log?.(`${label}: ${pct}%  ${humanSize(current)}/${humanSize(denom)}`);
        };
    }

    const sources = sourcesFor(asset, preference);
    for (const src of sources) {
        if (!src.url) continue;
        try {
            emit?.log?.(`Downloading from ${src.label}: ${asset.filename || key}`);
            await downloadFile(src.url, destPath, makeProgressLogger("download"));
            if (asset.sha256) {
                emit?.log?.("Verifying SHA256…");
                const h = await sha256OfFile(destPath, makeProgressLogger("verify"));
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
    MIRROR_TAG, MIRROR_BASE, MANIFEST_URL, FALLBACK_MANIFEST,
    loadManifest, downloadAsset, sha256OfFile, getPreference,
    // Back-compat alias — older code reads `MANIFEST` directly.
    MANIFEST: FALLBACK_MANIFEST.assets,
};
