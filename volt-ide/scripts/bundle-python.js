#!/usr/bin/env node
// Bundle a portable CPython into sdk/python/<platform>/ so the IDE
// is self-contained — users don't need Python or pip installed.
//
// Source: Astral's python-build-standalone (same distribution Ruff and
// uv use). One platform per invocation; defaults to the current host
// but accepts --platform=<key> for cross-target builds in CI.
//
// Output: sdk/python/<platform>/  — extracted directly, with lark
//         already pip-installed into its site-packages.

const fs = require("fs");
const path = require("path");
const https = require("https");
const crypto = require("crypto");
const { execFileSync } = require("child_process");

const PY_VERSION = "3.12.7";
const PBS_TAG    = "20241016";

const PLATFORMS = {
    "darwin-arm64": { triple: "aarch64-apple-darwin",      ext: "tar.gz", bin: "bin/python3" },
    "darwin-x64":   { triple: "x86_64-apple-darwin",       ext: "tar.gz", bin: "bin/python3" },
    "linux-x64":    { triple: "x86_64-unknown-linux-gnu",  ext: "tar.gz", bin: "bin/python3" },
    "win32-x64":    { triple: "x86_64-pc-windows-msvc",    ext: "tar.gz", bin: "python.exe"  },
};

function arg(name, fallback) {
    const a = process.argv.find(s => s.startsWith(`--${name}=`));
    return a ? a.slice(name.length + 3) : fallback;
}

const target = arg("platform", `${process.platform}-${process.arch}`);
const plat = PLATFORMS[target];
if (!plat) {
    console.error(`[bundle-python] unsupported platform: ${target}`);
    console.error(`               supported: ${Object.keys(PLATFORMS).join(", ")}`);
    process.exit(1);
}

const DOWNLOAD_URL = `https://github.com/astral-sh/python-build-standalone/releases/download/` +
                     `${PBS_TAG}/cpython-${PY_VERSION}+${PBS_TAG}-${plat.triple}-install_only.${plat.ext}`;

const SDK = path.resolve(__dirname, "..", "sdk");
const OUT = path.join(SDK, "python", target);
const TMP = path.join(SDK, `_python-${target}.${plat.ext}`);

function download(url, dest) {
    return new Promise((resolve, reject) => {
        const file = fs.createWriteStream(dest);
        function get(u, hops) {
            if (hops > 5) return reject(new Error("too many redirects"));
            https.get(u, res => {
                if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                    res.resume();
                    return get(new URL(res.headers.location, u).href, hops + 1);
                }
                if (res.statusCode !== 200) {
                    return reject(new Error(`HTTP ${res.statusCode} for ${u}`));
                }
                res.pipe(file);
                file.on("finish", () => file.close(() => resolve()));
                file.on("error", reject);
            }).on("error", reject);
        }
        get(url, 0);
    });
}

function mb(bytes) { return (bytes / 1024 / 1024).toFixed(1) + " MB"; }

function httpGetText(url) {
    return new Promise((resolve, reject) => {
        const get = (u, hops) => {
            if (hops > 5) return reject(new Error("too many redirects"));
            https.get(u, res => {
                if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                    res.resume();
                    return get(new URL(res.headers.location, u).href, hops + 1);
                }
                if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode} for ${u}`));
                let b = "";
                res.setEncoding("utf8");
                res.on("data", c => b += c);
                res.on("end", () => resolve(b));
            }).on("error", reject);
        };
        get(url, 0);
    });
}

function sha256File(p) { return crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex"); }

// Install lark into the bundled site-packages by extracting its pure-Python
// wheel (py3-none-any). This is CROSS-ARCH SAFE — it never runs the (possibly
// foreign-arch) bundled interpreter, so a single host can bundle lark for every
// target. lark has no runtime deps, so the wheel is self-complete. The wheel's
// sha256 is verified against PyPI's own metadata (no extra fetch).
async function installLark(outDir, target) {
    const site = target.startsWith("win32-")
        ? path.join(outDir, "Lib", "site-packages")
        : path.join(outDir, "lib", "python3.12", "site-packages");
    if (fs.existsSync(path.join(site, "lark", "__init__.py"))) {
        console.log("[bundle-python] lark already present, skipping");
        return;
    }
    console.log("[bundle-python] resolving lark wheel from PyPI...");
    const meta = JSON.parse(await httpGetText("https://pypi.org/pypi/lark/json"));
    const ver = meta.info.version;
    const wheel = (meta.releases[ver] || []).find(
        f => f.packagetype === "bdist_wheel" && /-py3-none-any\.whl$/.test(f.filename));
    if (!wheel) throw new Error("no pure-Python (py3-none-any) lark wheel on PyPI");

    const whl = path.join(SDK, `_lark-${ver}.whl`);
    await download(wheel.url, whl);
    const got = sha256File(whl);
    if (got !== wheel.digests.sha256) {
        fs.unlinkSync(whl);
        throw new Error(`lark wheel sha256 mismatch (got ${got.slice(0, 16)}…, want ${wheel.digests.sha256.slice(0, 16)}…)`);
    }
    fs.mkdirSync(site, { recursive: true });
    execFileSync("unzip", ["-o", "-q", whl, "-d", site], { stdio: "inherit" }); // a wheel is a zip
    fs.unlinkSync(whl);
    if (!fs.existsSync(path.join(site, "lark", "__init__.py")))
        throw new Error("lark did not extract into site-packages");
    console.log(`[bundle-python] lark ${ver} installed (sha256-verified, cross-arch) → ${site}`);
}

async function main() {
    fs.mkdirSync(path.dirname(TMP), { recursive: true });

    if (fs.existsSync(path.join(OUT, plat.bin))) {
        console.log(`[bundle-python] ${target} already bundled (${OUT}), skipping`);
        return;
    }

    console.log(`[bundle-python] target:  ${target}`);
    console.log(`[bundle-python] source:  ${DOWNLOAD_URL}`);
    console.log(`[bundle-python] dest:    ${OUT}`);

    console.log("[bundle-python] downloading...");
    await download(DOWNLOAD_URL, TMP);
    console.log(`[bundle-python] downloaded ${mb(fs.statSync(TMP).size)}`);

    // Integrity: python-build-standalone publishes a <asset>.sha256 companion.
    // Verify when present; a mismatch is fatal, absence falls back to TLS trust.
    try {
        const want = (await httpGetText(DOWNLOAD_URL + ".sha256")).trim().split(/\s+/)[0];
        if (want) {
            const got = sha256File(TMP);
            if (got !== want) throw new Error(`python tarball sha256 mismatch (got ${got.slice(0, 16)}…, want ${want.slice(0, 16)}…)`);
            console.log("[bundle-python] python tarball sha256 verified");
        }
    } catch (e) {
        if (/mismatch/.test(e.message)) { fs.unlinkSync(TMP); throw e; }
        console.warn("[bundle-python] no .sha256 companion — integrity via TLS only");
    }

    if (fs.existsSync(OUT)) fs.rmSync(OUT, { recursive: true, force: true });
    fs.mkdirSync(OUT, { recursive: true });

    console.log("[bundle-python] extracting...");
    // PBS tarballs put everything under a top-level "python/" — strip it.
    execFileSync("tar", ["-xzf", TMP, "-C", OUT, "--strip-components=1"], { stdio: "inherit" });
    fs.unlinkSync(TMP);

    const pyBin = path.join(OUT, plat.bin);
    if (!fs.existsSync(pyBin)) {
        throw new Error(`expected Python binary not found: ${pyBin}`);
    }

    // PBS install_only ships libpython with full debug symbols (~200 MB).
    // We don't need those at runtime — strip them. Saves ~180 MB on Linux,
    // ~150 MB on macOS. Windows PBS isn't affected.
    // Only strip when the host OS matches the target OS — host `strip` can't
    // process a foreign-OS binary (e.g. a Linux .so on macOS). Cross-OS bundles
    // ship unstripped (larger); the native per-OS build strips them for real.
    const targetOS = target.split("-")[0];
    const canStrip = (targetOS === "linux" || targetOS === "darwin") && targetOS === process.platform;
    if (canStrip) {
        const stripCmd = "strip";
        const stripArgs = targetOS === "darwin" ? ["-S"] : ["--strip-debug"];
        const libPattern = /^libpython.*\.(so\.|dylib).*/;
        const libDir = path.join(OUT, "lib");
        if (fs.existsSync(libDir)) {
            for (const f of fs.readdirSync(libDir)) {
                const full = path.join(libDir, f);
                if (libPattern.test(f) && !fs.lstatSync(full).isSymbolicLink()) {
                    const before = fs.statSync(full).size;
                    try {
                        execFileSync(stripCmd, [...stripArgs, full], { stdio: "pipe" });
                        const after = fs.statSync(full).size;
                        console.log(`[bundle-python] stripped ${f}: ${mb(before)} → ${mb(after)}`);
                    } catch (e) {
                        console.warn(`[bundle-python] strip ${f} failed (continuing):`, e.message);
                    }
                }
            }
        }
        // Strip the python binary itself (smaller savings, ~10 MB)
        try {
            execFileSync(stripCmd, [...stripArgs, pyBin], { stdio: "pipe" });
        } catch (_) {}
    }

    // lark is installed cross-arch by extracting its pure-Python wheel — works
    // for ANY target from ANY host, so a single machine can bundle every
    // platform and each bundle is complete (self-contained on the user's box).
    await installLark(OUT, target);

    // Strip pip's bundled Windows-PE launcher shims (t32/t64/w32/w64*.exe).
    // They're useless on Mac/Linux and trip electron-builder's codesign step
    // on macOS (errSecInternalComponent — codesign can't sign PE binaries).
    if (!target.startsWith("win32-")) {
        const distlib = path.join(OUT, "lib", "python3.12", "site-packages", "pip", "_vendor", "distlib");
        if (fs.existsSync(distlib)) {
            let removed = 0;
            for (const f of fs.readdirSync(distlib)) {
                if (f.endsWith(".exe")) {
                    fs.unlinkSync(path.join(distlib, f));
                    removed++;
                }
            }
            if (removed) console.log(`[bundle-python] stripped ${removed} Windows .exe shims from pip/distlib`);
        }
    }

    const total = execFileSync("du", ["-sh", OUT], { encoding: "utf-8" }).trim().split(/\s+/)[0];
    console.log(`[bundle-python] done — ${target} bundle is ${total}`);
}

main().catch(e => { console.error("[bundle-python] failed:", e.message); process.exit(1); });
