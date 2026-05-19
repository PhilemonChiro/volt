#!/usr/bin/env node
// Generate platform icons from assets/volt-logo.svg.
//
// Produces:
//   build/icon.png       — 512x512, used by Linux + macOS source
//   build/icon.ico       — multi-size Windows icon
//   build/icon.icns      — macOS icon (synthesized — for proper retina, run
//                           iconutil on a Mac; this fallback works for unsigned dev builds)
//
// Run automatically before pack:* via stage:sdk → no manual step needed.

const fs = require("fs");
const path = require("path");
const sharp = require("sharp");
const pngToIco = require("png-to-ico").default;

const SVG  = path.resolve(__dirname, "..", "assets", "volt-logo.svg");
const OUT  = path.resolve(__dirname, "..", "build");

async function main() {
    fs.mkdirSync(OUT, { recursive: true });
    if (!fs.existsSync(SVG)) {
        console.warn("[build-icons] missing assets/volt-logo.svg — skipping");
        return;
    }
    const svgBuf = fs.readFileSync(SVG);

    // 1. PNG — single 512×512 for Linux + macOS
    const pngPath = path.join(OUT, "icon.png");
    await sharp(svgBuf, { density: 512 }).resize(512, 512).png().toFile(pngPath);
    console.log("[build-icons] wrote", pngPath);

    // 2. ICO — multi-resolution for Windows
    const sizes = [16, 24, 32, 48, 64, 128, 256];
    const buffers = [];
    for (const sz of sizes) {
        buffers.push(await sharp(svgBuf, { density: sz * 2 }).resize(sz, sz).png().toBuffer());
    }
    const icoPath = path.join(OUT, "icon.ico");
    fs.writeFileSync(icoPath, await pngToIco(buffers));
    console.log("[build-icons] wrote", icoPath, `(${sizes.join("/")})`);

    // 3. ICNS — macOS. Real ICNS requires iconutil (Mac-only). For unsigned
    //    dev builds, electron-builder accepts a plain PNG renamed to .icns.
    //    It won't have all retina variants but the app will display.
    const icnsPath = path.join(OUT, "icon.icns");
    await sharp(svgBuf, { density: 1024 }).resize(1024, 1024).png().toFile(icnsPath);
    console.log("[build-icons] wrote", icnsPath, "(placeholder — proper .icns needs iconutil on macOS)");
}

main().catch(e => { console.error("[build-icons] failed:", e); process.exit(1); });
