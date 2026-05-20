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

const MIRROR_TAG     = "toolchains-2026.05";
const MIRROR_BASE    = `https://github.com/PhilemonChiro/volt-toolchains/releases/download/${MIRROR_TAG}`;
const MANIFEST_URL   = `${MIRROR_BASE}/manifest.json`;
const CACHE_PATH     = path.join(os.homedir(), ".volt", "cache", "manifest.json");
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
    },
    chip_requirements: {
        rp2040: {
            "darwin-arm64":  ["arm-gnu-toolchain-13.2-darwin-arm64", "cmake-3.30.5-macos-universal", "ninja-1.12.1-mac"],
            "darwin-x86_64": ["arm-gnu-toolchain-13.2-darwin-x86_64", "cmake-3.30.5-macos-universal", "ninja-1.12.1-mac"],
            "linux-x64":     [], // apt path handles it
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

// Cached manifest in-memory for the duration of the process so we don't
// re-fetch on every download.
let _manifestPromise = null;

function loadManifest(opts = {}) {
    if (_manifestPromise && !opts.force) return _manifestPromise;
    _manifestPromise = (async () => {
        // 1. Try in-memory cache via disk (within TTL)
        try {
            const st = fs.statSync(CACHE_PATH);
            if (Date.now() - st.mtimeMs < CACHE_TTL_MS) {
                const m = JSON.parse(fs.readFileSync(CACHE_PATH, "utf-8"));
                if (manifestIsCompatible(m)) return { manifest: m, source: "cache" };
            }
        } catch (_) {}

        // 2. Try remote fetch
        try {
            const m = await httpGetJson(MANIFEST_URL);
            if (manifestIsCompatible(m)) {
                try {
                    fs.mkdirSync(path.dirname(CACHE_PATH), { recursive: true });
                    fs.writeFileSync(CACHE_PATH, JSON.stringify(m, null, 2));
                } catch (_) {}
                return { manifest: m, source: "remote" };
            }
        } catch (_) {}

        // 3. Last resort: stale cache (TTL expired but still valid)
        try {
            const m = JSON.parse(fs.readFileSync(CACHE_PATH, "utf-8"));
            if (manifestIsCompatible(m)) return { manifest: m, source: "cache-stale" };
        } catch (_) {}

        // 4. Hard fallback: baked-in
        return { manifest: FALLBACK_MANIFEST, source: "fallback" };
    })();
    return _manifestPromise;
}

// ============================================================
// Asset download with source preference + SHA256 verification
// ============================================================
function sourcesFor(asset, preference) {
    if (preference === "upstream") return [{ url: asset.upstream, label: "upstream" }];
    if (preference === "mirror")   return [{ url: asset.url,      label: "Volt mirror" }];
    return [
        { url: asset.url,      label: "Volt mirror" },
        { url: asset.upstream, label: "upstream" },
    ];
}

// Download an asset by key. Returns true on success.
// Resolves the asset definition through loadManifest() so callers always
// get the latest published version (not whatever was baked into the IDE).
async function downloadAsset(key, destPath, emit, preference = "auto") {
    const { manifest, source } = await loadManifest();
    const asset = manifest.assets?.[key];
    if (!asset) throw new Error(`Unknown toolchain asset: ${key} (manifest source=${source})`);

    if (source !== "remote" && source !== "cache") {
        emit?.log?.(`Using ${source} manifest (could not fetch live)`);
    }

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
    MIRROR_TAG, MIRROR_BASE, MANIFEST_URL, FALLBACK_MANIFEST,
    loadManifest, downloadAsset, sha256OfFile, getPreference,
    // Back-compat alias — older code reads `MANIFEST` directly.
    MANIFEST: FALLBACK_MANIFEST.assets,
};
