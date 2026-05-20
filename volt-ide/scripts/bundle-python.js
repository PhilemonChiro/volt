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
    if (target.startsWith("linux") || target.startsWith("darwin")) {
        const stripCmd = target.startsWith("darwin") ? "strip" : "strip";
        const stripArgs = target.startsWith("darwin") ? ["-S"] : ["--strip-debug"];
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

    // Cross-target installs of lark would require pip wheels for that platform.
    // Only install for the host's own bundle — for cross-target builds, lark
    // gets installed by the runner that targets that platform (in CI each
    // platform job bundles its own Python AND installs lark for itself).
    const isHostBundle = target === `${process.platform}-${process.arch}`;
    if (isHostBundle) {
        console.log("[bundle-python] installing lark into bundled Python...");
        // Force install into the bundled Python's site-packages, ignoring the
        // host user's ~/.local/lib site (which "Requirement already satisfied"
        // would otherwise hit and skip a proper bundled install).
        const cleanEnv = { ...process.env, PYTHONNOUSERSITE: "1", PIP_USER: "0" };
        execFileSync(pyBin, [
            "-m", "pip", "install",
            "--no-warn-script-location", "--no-cache-dir",
            "--no-user", "--upgrade", "--force-reinstall", "lark",
        ], { stdio: "inherit", env: cleanEnv });
        // Verify it really landed in the bundled tree.
        execFileSync(pyBin, [
            "-c",
            "import lark, os; print('[bundle-python] lark', lark.__version__,'at',os.path.dirname(lark.__file__))",
        ], { stdio: "inherit", env: cleanEnv });
    } else {
        console.warn(`[bundle-python] target ${target} != host ${process.platform}-${process.arch};`);
        console.warn(`               skipping lark install (must run on a ${target} machine).`);
    }

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
