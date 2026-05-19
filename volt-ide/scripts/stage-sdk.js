#!/usr/bin/env node
// Stage the Volt SDK into volt-ide/sdk/ for electron-builder to bundle.
//
// What gets copied:
//   ../src/volt/        → sdk/src/volt/        (Python compiler)
//   ../devices/         → sdk/devices/         (device catalog JSON)
//   ../framework/       → sdk/framework/       (C runtime + drivers)
//
// electron-builder is configured to drop sdk/ into Contents/Resources/sdk
// (macOS) or resources/sdk (Windows/Linux) inside the packaged app.

const fs = require("fs");
const path = require("path");

const REPO = path.resolve(__dirname, "..", "..");
const OUT  = path.resolve(__dirname, "..", "sdk");

const PYCACHE = /__pycache__/;
const PYCFILE = /\.py[co]$/;
const BUILD_ART = /^(build|_deps|managed_components|sdkconfig.*|\.tox)$/;

function copyTree(srcDir, dstDir) {
    if (!fs.existsSync(srcDir)) {
        console.warn(`[stage-sdk] missing: ${srcDir}`);
        return 0;
    }
    fs.mkdirSync(dstDir, { recursive: true });
    let n = 0;
    for (const name of fs.readdirSync(srcDir)) {
        if (PYCACHE.test(name) || PYCFILE.test(name)) continue;
        if (BUILD_ART.test(name)) continue;
        const src = path.join(srcDir, name);
        const dst = path.join(dstDir, name);
        const st = fs.statSync(src);
        if (st.isDirectory()) n += copyTree(src, dst);
        else { fs.copyFileSync(src, dst); n++; }
    }
    return n;
}

function rmTree(dir) {
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

function fmtSize(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

function dirSize(dir) {
    let total = 0;
    function walk(d) {
        for (const n of fs.readdirSync(d)) {
            const p = path.join(d, n);
            const st = fs.statSync(p);
            if (st.isDirectory()) walk(p);
            else total += st.size;
        }
    }
    walk(dir);
    return total;
}

console.log("[stage-sdk] cleaning sdk/");
rmTree(OUT);
fs.mkdirSync(OUT, { recursive: true });

const targets = [
    { from: path.join(REPO, "src"),       to: path.join(OUT, "src"),       label: "compiler" },
    { from: path.join(REPO, "devices"),   to: path.join(OUT, "devices"),   label: "devices" },
    { from: path.join(REPO, "framework"), to: path.join(OUT, "framework"), label: "framework" },
];

for (const t of targets) {
    const n = copyTree(t.from, t.to);
    const sz = fs.existsSync(t.to) ? fmtSize(dirSize(t.to)) : "missing";
    console.log(`[stage-sdk] ${t.label}: ${n} files, ${sz}`);
}

const total = fmtSize(dirSize(OUT));
console.log(`[stage-sdk] done — total sdk/ size: ${total}`);
