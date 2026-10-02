#!/usr/bin/env node
// Build the `volt` CLI (../../cli/cmd/volt) into bin/<platform>-<arch>/, the
// layout src/main/volt-cli.js looks in. Linux and Windows are pure Go and
// cross-compile from any host; macOS needs cgo (IOKit serial enumeration),
// so darwin targets build only on a Mac.
//
//   node scripts/build-volt.js                         # this machine
//   node scripts/build-volt.js darwin-arm64 win32-x64  # named targets

const { execFileSync } = require("child_process");
const path = require("path");

const GOOS = { darwin: "darwin", linux: "linux", win32: "windows" };
const GOARCH = { arm64: "arm64", x64: "amd64" };
const CLI = path.resolve(__dirname, "..", "..", "..", "cli");

const targets = process.argv.slice(2);
if (!targets.length) targets.push(`${process.platform}-${process.arch}`);

for (const t of targets) {
    const [plat, arch] = t.split("-");
    if (!GOOS[plat] || !GOARCH[arch]) throw new Error(`unknown target ${t}`);
    if (plat === "darwin" && process.platform !== "darwin") {
        throw new Error(`${t}: macOS builds need cgo, so they must run on a Mac`);
    }
    const exe = plat === "win32" ? "volt.exe" : "volt";
    const out = path.join(__dirname, "..", "bin", t, exe);
    execFileSync("go", ["build", "-trimpath", "-o", out, "./cmd/volt"], {
        cwd: CLI,
        env: {
            ...process.env,
            CGO_ENABLED: plat === "darwin" ? "1" : "0",
            GOOS: GOOS[plat],
            GOARCH: GOARCH[arch],
        },
        stdio: "inherit",
    });
    console.log(`[build-volt] ${path.relative(process.cwd(), out)}`);
}
