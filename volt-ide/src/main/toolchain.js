// Toolchain auto-setup — downloads and configures build tools per chip
// Ported from Tauri toolchain.rs

const { execSync, spawn, spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");
const mirror = require("./toolchain-mirror");

const TOOLCHAINS_DIR = path.join(os.homedir(), ".volt", "toolchains");

// Where the bundled Python lives inside the packaged .app/.AppImage/.exe.
// In dev mode this just falls back to system "python3".
function bundledPythonBin() {
    const platKey = `${process.platform}-${process.arch}`;
    const ext = process.platform === "win32" ? "python.exe" : "bin/python3";
    if (process.resourcesPath) {
        const p = path.join(process.resourcesPath, "sdk", "python", platKey, ext);
        if (fs.existsSync(p)) return p;
    }
    const devP = path.join(__dirname, "..", "..", "sdk", "python", platKey, ext);
    if (fs.existsSync(devP)) return devP;
    return null;
}

// Portable cmake + ninja paths (macOS only — Linux uses apt, Windows uses Espressif's installer)
function cmakeBin() {
    if (process.platform !== "darwin") return null;
    const p = path.join(TOOLCHAINS_DIR, "cmake", "CMake.app", "Contents", "bin", "cmake");
    return fs.existsSync(p) ? p : null;
}
function ninjaBin() {
    if (process.platform !== "darwin") return null;
    const p = path.join(TOOLCHAINS_DIR, "ninja", "ninja");
    return fs.existsSync(p) ? p : null;
}
// Portable ARM GCC (arm-none-eabi-gcc) for macOS — Linux uses apt.
function armGccBin() {
    if (process.platform !== "darwin") return null;
    const p = path.join(TOOLCHAINS_DIR, "arm-gnu-toolchain", "bin", "arm-none-eabi-gcc");
    return fs.existsSync(p) ? p : null;
}

// Portable picotool for RP2040 direct-USB flashing. Bundled with libusb-1.0
// alongside (rpath/install_name rewritten so the binary finds it next to
// itself). Available for darwin-arm64 and linux-x64 today.
function picotoolBin() {
    const p = path.join(TOOLCHAINS_DIR, "picotool", "picotool");
    return fs.existsSync(p) ? p : null;
}

// Build the PATH prefix needed to compile ESP-IDF projects: bundled Python
// first (so install.sh / activate_venv pick 3.12+), then cmake, then ninja.
// Caller prepends to their own PATH.
function buildPathPrefix() {
    const parts = [];
    const py = bundledPythonBin();
    if (py) parts.push(path.dirname(py));
    const cm = cmakeBin();
    if (cm) parts.push(path.dirname(cm));
    const nj = ninjaBin();
    if (nj) parts.push(path.dirname(nj));
    const arm = armGccBin();
    if (arm) parts.push(path.dirname(arm));
    const pt = picotoolBin();
    if (pt) parts.push(path.dirname(pt));
    return parts.join(path.delimiter);
}

// Ensure portable cmake + ninja are installed under TOOLCHAINS_DIR.
// macOS only — Linux uses apt (handled separately), Windows uses Espressif's
// installer that bundles its own.
// Portable ARM GNU toolchain (arm-none-eabi-gcc) for macOS.
// Arm publishes prebuilt darwin-arm64 + darwin-x86_64 tarballs. We pin 13.2
// for stability (same compiler family the Pico SDK is tested against).
async function ensureArmGcc(emit) {
    if (process.platform !== "darwin") return true;
    if (armGccBin()) { emit.log("ARM GCC already present"); return true; }
    ensureDir(TOOLCHAINS_DIR);
    const key = process.arch === "arm64"
        ? "arm-gnu-toolchain-13.2-darwin-arm64"
        : "arm-gnu-toolchain-13.2-darwin-x86_64";
    const tmp = path.join(TOOLCHAINS_DIR, "_arm-gnu.tar.xz");
    emit.log(`Fetching ARM GCC 13.2 (~280 MB)…`);
    const ok = await mirror.downloadAsset(key, tmp, emit, mirror.getPreference());
    if (!ok) { emit.log("ERROR: ARM GCC download failed from all sources"); return false; }
    const out = path.join(TOOLCHAINS_DIR, "arm-gnu-toolchain");
    fs.mkdirSync(out, { recursive: true });
    const ex = await extractArchive(tmp, out, "tar.xz", emit.log);
    if (!ex.ok) {
        emit.log(`ERROR: ARM GCC extract failed: ${ex.error}`);
        try { fs.unlinkSync(tmp); } catch (_) {}
        return false;
    }
    try { fs.unlinkSync(tmp); } catch (_) {}
    emit.log("ARM GCC installed");
    return true;
}

// Portable picotool — direct USB flashing for RP2040. Pico Foundation doesn't
// publish prebuilt binaries; we built and uploaded our own (bundled with
// libusb-1.0 next to the binary, install_name/rpath rewritten).
//
// darwin-arm64 + linux-x64 today. darwin-x86_64 and win-x64 are pending —
// users on those platforms fall back to the BOOTSEL volume-copy path.
async function ensurePicotool(emit) {
    if (picotoolBin()) { emit.log("picotool already present"); return true; }

    let key;
    if (process.platform === "darwin" && process.arch === "arm64") {
        key = "picotool-2.1-darwin-arm64";
    } else if (process.platform === "linux" && (process.arch === "x64" || process.arch === "x86_64")) {
        key = "picotool-2.1-linux-x64";
    } else {
        // Platform not supported by the bundled picotool yet — soft skip.
        // flashRP2040 will fall back to the BOOTSEL volume-copy path.
        emit.log(`picotool: no prebuilt available for ${process.platform}-${process.arch}; skipping (BOOTSEL copy will still work)`);
        return true;
    }

    ensureDir(TOOLCHAINS_DIR);
    const tmp = path.join(TOOLCHAINS_DIR, "_picotool.tar.gz");
    emit.log("Fetching picotool 2.1 (~1 MB)…");
    const ok = await mirror.downloadAsset(key, tmp, emit, mirror.getPreference());
    if (!ok) {
        emit.log("WARN: picotool download failed — RP2040 flashing will require BOOTSEL");
        return true;  // not fatal; BOOTSEL copy still works
    }
    const out = path.join(TOOLCHAINS_DIR, "picotool");
    fs.mkdirSync(out, { recursive: true });
    const ex = await extractArchive(tmp, out, "tar.gz", emit.log);
    if (!ex.ok) {
        emit.log(`WARN: picotool extract failed: ${ex.error}`);
        try { fs.unlinkSync(tmp); } catch (_) {}
        return true;
    }
    try {
        fs.chmodSync(path.join(out, "picotool"), 0o755);
        fs.unlinkSync(tmp);
    } catch (_) {}

    // macOS-only: re-sign the binary + bundled dylib with an ad-hoc
    // signature. The linker-supplied ad-hoc signature gets rejected by
    // Gatekeeper when the binary lives in a non-system path; an explicit
    // `codesign --force --deep --sign -` here makes it pass. Without this,
    // the binary launches and is killed with SIGKILL (exit 137).
    if (process.platform === "darwin") {
        try {
            const { spawnSync } = require("child_process");
            spawnSync("xattr", ["-dr", "com.apple.quarantine", out], { stdio: "ignore" });
            spawnSync("codesign", ["--force", "--deep", "--sign", "-",
                                   path.join(out, "picotool")], { stdio: "ignore" });
            const dylib = path.join(out, "lib", "libusb-1.0.0.dylib");
            if (fs.existsSync(dylib)) {
                spawnSync("codesign", ["--force", "--deep", "--sign", "-", dylib], { stdio: "ignore" });
            }
        } catch (e) {
            emit.log(`WARN: picotool re-sign failed: ${e.message} (binary may be Gatekeeper-blocked)`);
        }
    }

    emit.log("picotool installed — direct-USB flashing enabled");
    return true;
}

async function ensureCmakeNinja(emit) {
    if (process.platform !== "darwin") return true;
    ensureDir(TOOLCHAINS_DIR);
    const arch = process.arch === "arm64" ? "arm64" : "x86_64";

    if (!cmakeBin()) {
        emit.log("Fetching cmake (~70 MB)…");
        const tmp = path.join(TOOLCHAINS_DIR, "_cmake.tar.gz");
        const ok = await mirror.downloadAsset("cmake-3.30.5-macos-universal", tmp, emit, mirror.getPreference());
        if (!ok) { emit.log("ERROR: cmake download failed from all sources"); return false; }
        const out = path.join(TOOLCHAINS_DIR, "cmake");
        fs.mkdirSync(out, { recursive: true });
        const ex = await extractArchive(tmp, out, "tar.gz", emit.log);
        if (!ex.ok) {
            emit.log(`ERROR: cmake extract failed: ${ex.error}`);
            try { fs.unlinkSync(tmp); } catch (_) {}
            return false;
        }
        try { fs.unlinkSync(tmp); } catch (_) {}
        emit.log("cmake installed");
    } else {
        emit.log("cmake already present");
    }

    if (!ninjaBin()) {
        emit.log("Fetching ninja…");
        const tmp = path.join(TOOLCHAINS_DIR, "_ninja.zip");
        const ok = await mirror.downloadAsset("ninja-1.12.1-mac", tmp, emit, mirror.getPreference());
        if (!ok) { emit.log("ERROR: ninja download failed from all sources"); return false; }
        const out = path.join(TOOLCHAINS_DIR, "ninja");
        fs.mkdirSync(out, { recursive: true });
        const ex = await extractArchive(tmp, out, "zip", emit.log);
        if (!ex.ok) {
            emit.log(`ERROR: ninja extract failed: ${ex.error}`);
            try { fs.unlinkSync(tmp); } catch (_) {}
            return false;
        }
        try {
            fs.chmodSync(path.join(out, "ninja"), 0o755);
            fs.unlinkSync(tmp);
        } catch (_) {}
        emit.log("ninja installed");
    } else {
        emit.log("ninja already present");
    }
    return true;
}

function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); }

function hasCommand(name) {
    try {
        execSync(`which ${name}`, { stdio: "ignore" });
        return true;
    } catch { return false; }
}

// Async streaming command runner. Uses spawn() so:
//  - main process event loop stays free (IPC + window events keep flowing)
//  - stdout/stderr is forwarded line-by-line in real time (no end-of-process
//    flood, progress regexes in makeEmit fire as data arrives)
//  - long-running commands (install.sh, git clone) don't freeze the IDE
//
// Returns Promise<{ ok, output, code }>. All callers must await.
// `log` is the legacy plain-log callback OR the emit's log fn — either way,
// each line is passed through individually so makeEmit's progress regex
// catches them.
function run(cmd, log) {
    if (log) log(cmd);
    return new Promise((resolve) => {
        const child = spawn("bash", ["-c", cmd], {
            stdio: ["ignore", "pipe", "pipe"],
            env: process.env,
        });
        let output = "";
        const pipeStream = (stream) => {
            let buf = "";
            stream.setEncoding("utf-8");
            stream.on("data", (chunk) => {
                buf += chunk;
                let nl;
                while ((nl = buf.indexOf("\n")) !== -1) {
                    const line = buf.slice(0, nl);
                    buf = buf.slice(nl + 1);
                    output += line + "\n";
                    if (log) log(line);
                }
            });
            stream.on("end", () => {
                if (buf) {
                    output += buf;
                    if (log) log(buf);
                }
            });
        };
        pipeStream(child.stdout);
        pipeStream(child.stderr);
        child.on("error", (e) => resolve({ ok: false, output: e.message, code: -1 }));
        child.on("close", (code) => resolve({ ok: code === 0, output, code }));
    });
}

// Upstream SDKs pinned to EXACT commit SHAs. Cloning a moving branch or a
// re-pointable tag lets a compromised or force-pushed upstream slip unexpected
// code into the firmware build; pinning + verifying the checked-out commit
// removes that. To upgrade an SDK, bump its `sha` here (taken from the trusted
// release tag in `ref`).
const PINNED_SDK = {
    "pico-sdk": { url: "https://github.com/raspberrypi/pico-sdk.git",       sha: "95ea6acad131124694cda1c162c52cd30e0aece0", ref: "2.1.0" },
    "picotool": { url: "https://github.com/raspberrypi/picotool.git",       sha: "df21059f7ca6f1babc7f1f3b92122cacffc85951", ref: "2.1.0" },
    "esp-idf":  { url: "https://github.com/espressif/esp-idf.git",          sha: "67c1de1eebe095d554d281952fde63c16ee2dca0", ref: "v5.4" },
    "esp8266":  { url: "https://github.com/espressif/ESP8266_RTOS_SDK.git", sha: "89a3f254b63819035f65d9c5dcdae8864f1a6a8a", ref: "v3.4" },
};

// Clone a pinned SDK at its exact commit and VERIFY the checkout matches — then
// (optionally) init submodules, which are pinned transitively by the
// superproject's recorded gitlinks. Fetch-by-SHA keeps the clone shallow
// (GitHub serves reachable SHAs). A mismatch aborts and wipes the dir rather
// than building against unexpected code. Returns { ok }.
async function cloneAtSha(name, dest, submodules, run, log) {
    const p = PINNED_SDK[name];
    if (!p) return { ok: false };
    const steps = [
        `git init -q "${dest}"`,
        `git -C "${dest}" remote add origin ${p.url}`,
        `git -C "${dest}" fetch -q --depth 1 origin ${p.sha}`,
        `git -C "${dest}" -c advice.detachedHead=false checkout -q ${p.sha}`,
    ];
    if (submodules) steps.push(`git -C "${dest}" submodule update -q --init --recursive --depth 1`);
    const r = await run(`${steps.join(" && ")} 2>&1`, log);
    if (!r.ok) return { ok: false };

    const head = await run(`git -C "${dest}" rev-parse HEAD`, log);
    const got = (head.output || "").trim();
    if (got !== p.sha) {
        log(`SECURITY: ${name} HEAD ${got || "unknown"} != pinned ${p.sha} — refusing to use`);
        try { fs.rmSync(dest, { recursive: true, force: true }); } catch (_) {}
        return { ok: false };
    }
    log(`${name} pinned @ ${p.ref} (${p.sha.slice(0, 12)}…)`);
    return { ok: true };
}

// Async streaming extract. Same rationale as run() — tar -xJf on the 280 MB
// Arm GCC tarball blocks for ~6 s, which is long enough that the dialog
// timer pauses and any in-flight log lines get queued. Using spawn keeps
// main responsive and lets us pass progress messages through.
function extractArchive(archivePath, outDir, format, log) {
    return new Promise((resolve) => {
        let argv;
        if (format === "tar.xz")      argv = ["tar", "-xJf", archivePath, "-C", outDir, "--strip-components=1"];
        else if (format === "tar.gz") argv = ["tar", "-xzf", archivePath, "-C", outDir, "--strip-components=1"];
        else if (format === "zip")    argv = ["unzip", "-o", archivePath, "-d", outDir];
        else                          return resolve({ ok: false, error: `unknown archive format: ${format}` });

        // makeEmit picks up the "extract:" prefix and forwards a stage_progress
        // event that the dialog treats as indeterminate (barber-pole).
        if (log) log(`extract: ${path.basename(archivePath)}`);
        const child = spawn(argv[0], argv.slice(1), { stdio: ["ignore", "pipe", "pipe"] });
        let stderr = "";
        child.stdout.on("data", () => {}); // suppress unzip's per-file noise from the dialog log
        child.stderr.setEncoding("utf-8");
        child.stderr.on("data", (chunk) => { stderr += chunk; });
        child.on("error", (e) => resolve({ ok: false, error: e.message }));
        child.on("close", (code) => {
            if (code === 0) resolve({ ok: true });
            else resolve({ ok: false, error: stderr.trim() || `${argv[0]} exited ${code}` });
        });
    });
}

// Wraps a legacy log(string) callback into an emit object the new flow uses.
// emit.log(msg) — text passthrough
// emit.stage(id) / stageDone(id) / stageError(id, msg) — structured stage events
// emit.progress(id, pct, detail) — sub-progress within a stage
// Detects common progress patterns (git, curl) in log output and forwards
// them automatically as progress events without ensure* needing to know.
function makeEmit(legacy) {
    // legacy can be either a plain log(string) fn OR an emit-shaped object.
    if (legacy && typeof legacy === "object" && typeof legacy.stage === "function") {
        return legacy;
    }
    const logFn = typeof legacy === "function" ? legacy : () => {};
    let currentStageId = null;
    // idf_tools.py tool-install tracking. Reset on each stage start.
    let toolPlan = null;       // [name, name, ...] from "Installing tools: a, b, c"
    let toolsInstalled = 0;
    const emit = {
        log: (msg) => {
            logFn(msg);
            // Detect progress patterns in the message
            if (!currentStageId) return;
            const s = String(msg);
            // git: "Receiving objects:  33% (15234/46123)"
            let m = s.match(/(?:Receiving objects|Resolving deltas):\s+(\d+)%\s*\(([\d.]+)\/([\d.]+)\)/);
            if (m) { emit.progress(currentStageId, +m[1], `git: ${m[2]} / ${m[3]} objects`); return; }
            // toolchain-mirror: "download: 45%  130.5M/280.0M" (or "verify: …")
            m = s.match(/^(\w+):\s+(\d+)%\s+([\d.]+[KMG]?)\s*\/\s*([\d.]+[KMG]?)/);
            if (m) { emit.progress(currentStageId, +m[2], `${m[1]} ${m[3]} / ${m[4]}`); return; }
            // curl/wget: " 45%  300M/700M"
            m = s.match(/(\d+)%\s+([\d.]+[KMG]?)\s*\/\s*([\d.]+[KMG]?)/);
            if (m) { emit.progress(currentStageId, +m[1], `${m[2]} / ${m[3]}`); return; }
            // tar / unzip — no byte progress is available. Fire one
            // progress event with an "extract:" detail; the dialog uses it
            // to switch the bar to indeterminate barber-pole.
            m = s.match(/^extract:\s+(.+)/);
            if (m) { emit.progress(currentStageId, 0, `extract: ${m[1]}`); return; }
            // idf_tools.py — tool plan announcement (sets the total)
            //   "Installing tools: xtensa-esp-elf, riscv32-esp-elf, esp32ulp-elf, …"
            m = s.match(/^Installing tools:\s+(.+)$/);
            if (m) {
                toolPlan = m[1].split(",").map(t => t.trim()).filter(Boolean);
                toolsInstalled = 0;
                emit.progress(currentStageId, 0, `0 / ${toolPlan.length} tools`);
                return;
            }
            // idf_tools.py — a tool starts installing or is skipped (already cached)
            //   "Installing xtensa-esp-elf@esp-14.2.0_20241119"
            //   "Skipping cmake@3.30.2-3-gcc31810 (already installed)"
            if (toolPlan) {
                m = s.match(/^(?:Installing|Skipping)\s+([^\s@]+)@/);
                if (m) {
                    toolsInstalled++;
                    const pct = Math.min(100, Math.floor(toolsInstalled / toolPlan.length * 100));
                    emit.progress(currentStageId, pct, `tool ${toolsInstalled} / ${toolPlan.length}: ${m[1]}`);
                    return;
                }
                // Post-tool stage of idf_tools: Python virtualenv setup
                // (~7-10s, no inherent progress). Don't reset our pct.
                if (/^(Installing Python|Setting up Python|Successfully installed)/i.test(s)) {
                    emit.progress(currentStageId, 100, `Python venv: ${s.slice(0, 60)}`);
                    return;
                }
            }
            // apt: "Reading package lists..." / "Setting up <pkg>"
            if (/^Setting up\b/.test(s)) emit.progress(currentStageId, 75, s.slice(0, 80));
            if (/^Reading package lists/.test(s)) emit.progress(currentStageId, 10, s.slice(0, 80));
            if (/^Unpacking\b/.test(s))   emit.progress(currentStageId, 50, s.slice(0, 80));
        },
        stage: (id) => {
            currentStageId = id;
            toolPlan = null;
            toolsInstalled = 0;
            logFn(`__STAGE__:${id}:start`);
        },
        stageDone: (id) => {
            if (currentStageId === id) currentStageId = null;
            logFn(`__STAGE__:${id}:done`);
        },
        stageError: (id, msg) => {
            if (currentStageId === id) currentStageId = null;
            logFn(`__STAGE__:${id}:error:${msg || ""}`);
        },
        progress: (id, percent, detail) => {
            logFn(`__STAGE__:${id}:progress:${percent}:${detail || ""}`);
        },
    };
    return emit;
}

// ================================================================
// RP2040 — Pico SDK + ARM GCC + picotool
// ================================================================

function picoSdkPath() {
    // 1. user override from Settings
    try {
        const override = require("./settings").get("build.picoSdkPath");
        if (override && override.trim()) return override;
    } catch (_) {}
    // 2. environment variable (standard pico-sdk convention)
    if (process.env.PICO_SDK_PATH) return process.env.PICO_SDK_PATH;
    // 3. local managed install
    return path.join(TOOLCHAINS_DIR, "pico-sdk");
}

async function ensureRP2040(legacy) {
    const emit = makeEmit(legacy);
    const log = emit.log;
    ensureDir(TOOLCHAINS_DIR);

    emit.stage("check");
    log("Checking RP2040 prerequisites...");
    emit.stageDone("check");

    // 1. ARM GCC — Linux: apt; macOS: portable Arm tarball; Windows: TODO
    emit.stage("arm-gcc");
    if (process.platform === "linux") {
        if (!hasCommand("arm-none-eabi-gcc")) {
            log("Installing ARM GCC toolchain via apt...");
            const r = await run("sudo apt-get install -y gcc-arm-none-eabi libnewlib-arm-none-eabi 2>&1", log);
            if (!r.ok) {
                log("ERROR: Failed to install ARM GCC. Run manually: sudo apt install gcc-arm-none-eabi");
                emit.stageError("arm-gcc", "apt install failed");
                return false;
            }
        } else {
            log("ARM GCC already installed");
        }
    } else if (process.platform === "darwin") {
        const ok = await ensureArmGcc(emit);
        if (!ok) { emit.stageError("arm-gcc", "download failed"); return false; }
    } else {
        log("ARM GCC auto-install on this platform is not implemented yet.");
        log("Install arm-none-eabi-gcc manually and re-run.");
        if (!hasCommand("arm-none-eabi-gcc")) {
            emit.stageError("arm-gcc", "not installed");
            return false;
        }
    }
    emit.stageDone("arm-gcc");

    // 2. cmake — Linux apt; macOS portable
    emit.stage("cmake");
    if (process.platform === "linux") {
        if (!hasCommand("cmake")) {
            log("Installing cmake via apt...");
            const r = await run("sudo apt-get install -y cmake 2>&1", log);
            if (!r.ok) { emit.stageError("cmake", "apt install failed"); return false; }
        } else {
            log("cmake already installed");
        }
    } else if (process.platform === "darwin") {
        // ensureCmakeNinja handles cmake AND ninja (Pico SDK CMakeLists wants ninja too)
        const ok = await ensureCmakeNinja(emit);
        if (!ok) { emit.stageError("cmake", "download failed"); return false; }
    }
    emit.stageDone("cmake");

    // 3. Pico SDK — git clone, same on every platform
    emit.stage("clone-sdk");
    const sdk = picoSdkPath();
    const sdkLooksComplete = fs.existsSync(path.join(sdk, "pico_sdk_init.cmake")) &&
                             fs.existsSync(path.join(sdk, "src", "CMakeLists.txt"));
    if (!sdkLooksComplete) {
        if (fs.existsSync(sdk)) {
            log("Partial Pico SDK clone detected — wiping and starting fresh");
            try { fs.rmSync(sdk, { recursive: true, force: true }); } catch (_) {}
        }
        log("Downloading Raspberry Pi Pico SDK (pinned)...");
        const r = await cloneAtSha("pico-sdk", sdk, true, run, log);
        if (!r.ok) {
            emit.stageError("clone-sdk", "pinned SDK clone/verify failed (check internet)");
            return false;
        }
        log("Pico SDK ready");
    } else {
        log("Pico SDK already present");
    }
    emit.stageDone("clone-sdk");

    // 4. picotool — prebuilt bundle from volt-toolchains release (~1 MB).
    // Enables direct USB flashing: no BOOTSEL hold needed for routine
    // reflashes, faster than the MSC-copy path (uses picoboot USB
    // protocol directly). If the download fails or the platform has no
    // prebuilt, we degrade gracefully — the BOOTSEL volume-copy path
    // (in builder.js flashRP2040) is unaffected.
    emit.stage("picotool");
    if (picotoolBin() || hasCommand("picotool")) {
        log("picotool already installed");
        emit.stageDone("picotool");
    } else {
        log("Installing picotool for direct USB flashing...");
        const ok = await ensurePicotool(emit);
        if (ok && picotoolBin()) {
            emit.stageDone("picotool");
        } else if (process.platform === "linux") {
            // Linux fallback: build from source via the legacy installer.
            log("Prebuilt unavailable — falling back to source build");
            if (!(await installPicotool(emit))) {
                log("picotool source build failed — BOOTSEL mode still works");
                emit.stageError("picotool", "source build failed (BOOTSEL still works)");
            } else {
                emit.stageDone("picotool");
            }
        } else {
            log("picotool not available on this platform — BOOTSEL mode will be used (hold BOOTSEL, plug Pico, click Run).");
            emit.stageDone("picotool");
        }
    }

    // 5. udev rules — Linux only
    emit.stage("udev");
    if (process.platform === "linux") {
        await setupRP2040Udev(emit);
    } else {
        log("Skipping udev (not Linux)");
    }
    emit.stageDone("udev");

    return true;
}

async function installPicotool(emit) {
    const log = emit && emit.log ? emit.log : (emit || (() => {}));
    // Need libusb
    await run("sudo apt-get install -y libusb-1.0-0-dev 2>&1", log);

    const picotoolDir = path.join(TOOLCHAINS_DIR, "picotool-build");
    ensureDir(picotoolDir);

    const srcDir = path.join(picotoolDir, "src");
    if (!fs.existsSync(path.join(srcDir, "CMakeLists.txt"))) {
        log("Downloading picotool source (pinned)...");
        const r = await cloneAtSha("picotool", srcDir, false, run, log);
        if (!r.ok) return false;
    }

    const buildDir = path.join(picotoolDir, "build");
    ensureDir(buildDir);
    const sdk = picoSdkPath();

    log("Configuring picotool...");
    let r = await run(`cmake -S "${srcDir}" -B "${buildDir}" -DPICO_SDK_PATH="${sdk}" -DCMAKE_BUILD_TYPE=Release 2>&1`, log);
    if (!r.ok) return false;

    log("Building picotool (takes ~30s)...");
    r = await run(`cmake --build "${buildDir}" --parallel 2>&1`, log);
    if (!r.ok) return false;

    // Install
    r = await run(`sudo cp "${buildDir}/picotool" /usr/local/bin/picotool 2>&1`);
    if (!r.ok) {
        // Try ~/.local/bin
        const localBin = path.join(os.homedir(), ".local", "bin");
        ensureDir(localBin);
        try { fs.copyFileSync(path.join(buildDir, "picotool"), path.join(localBin, "picotool")); }
        catch { return false; }
    }

    log("picotool installed");
    await setupRP2040Udev(log);
    return true;
}

async function setupRP2040Udev(emit) {
    const log = emit && emit.log ? emit.log : (emit || (() => {}));
    const rulesPath = "/etc/udev/rules.d/99-pico.rules";
    if (fs.existsSync(rulesPath)) return;

    log("Setting up USB permissions for Pico...");
    const rules = '# Raspberry Pi Pico\nSUBSYSTEM=="usb", ATTRS{idVendor}=="2e8a", TAG+="uaccess"\nSUBSYSTEM=="tty", ATTRS{idVendor}=="2e8a", MODE="0666"\n';
    const tmp = path.join(os.tmpdir(), "99-pico.rules");
    fs.writeFileSync(tmp, rules);

    const r = await run(`sudo cp "${tmp}" "${rulesPath}" && sudo udevadm control --reload-rules && sudo udevadm trigger 2>&1`);
    if (r.ok) {
        log("USB permissions configured. Unplug and replug Pico to apply.");
    } else {
        log("Could not set udev rules. Serial may need sudo. Run: sudo usermod -a -G dialout $USER");
    }
}

// ================================================================
// ESP32 / ESP8266 — ESP-IDF
// ================================================================

function espIdfPath(chip) {
    if (chip.includes("8266")) {
        return path.join(TOOLCHAINS_DIR, "esp8266-rtos-sdk");
    }
    // 1. user override from Settings
    try {
        const override = require("./settings").get("build.espIdfPath");
        if (override && override.trim()) return override;
    } catch (_) {}
    // 2. environment variable
    if (process.env.IDF_PATH) return process.env.IDF_PATH;
    // 3. common dev location
    const devPath = path.join(os.homedir(), "esp", "esp-idf");
    if (fs.existsSync(devPath)) return devPath;
    // 4. local managed install
    return path.join(TOOLCHAINS_DIR, "esp-idf");
}

async function ensureEspIdf(chip, legacy) {
    const emit = makeEmit(legacy);
    const log = emit.log;
    ensureDir(TOOLCHAINS_DIR);

    emit.stage("check");
    log(`Checking ${chip} prerequisites...`);
    const py = bundledPythonBin();
    if (py) log(`Using bundled Python: ${py}`);
    emit.stageDone("check");

    // Install deps: on macOS we download portable cmake + ninja; on Linux apt
    // handles them as part of the system packages. Both are no-ops on resume
    // (skip the apt prompt if everything's already on PATH; ensureCmakeNinja
    // checks for existing binaries before downloading).
    emit.stage("deps");
    if (process.platform === "linux") {
        const linuxDeps = ["git", "wget", "flex", "bison", "gperf", "python3", "cmake", "ninja"];
        const missingLinuxDep = linuxDeps.find(c => !hasCommand(c));
        if (missingLinuxDep) {
            log(`Installing system dependencies via apt (missing: ${missingLinuxDep})...`);
            await run("sudo apt-get install -y git wget flex bison gperf python3 python3-pip cmake ninja-build ccache libffi-dev libssl-dev dfu-util libusb-1.0-0 2>&1", log);
        } else {
            log("Linux system dependencies already present — skipping apt");
        }
    } else if (process.platform === "darwin") {
        const ok = await ensureCmakeNinja(emit);
        if (!ok) {
            emit.stageError("deps", "cmake/ninja install failed");
            return false;
        }
    }
    emit.stageDone("deps");

    const idf = espIdfPath(chip);
    emit.stage("clone-idf");
    // Decide: skip / resume-submodules / wipe-and-reclone.
    // Clone is "complete" if export.sh + install.sh + components/ (≥20 entries)
    // + tools/idf.py are all present. Anything less means partial — wipe and
    // restart clone (safer than trying to repair an interrupted git state).
    const cloneLooksComplete = (
        fs.existsSync(path.join(idf, "export.sh")) &&
        fs.existsSync(path.join(idf, "install.sh")) &&
        fs.existsSync(path.join(idf, "tools", "idf.py")) &&
        (() => {
            try {
                const comp = path.join(idf, "components");
                return fs.existsSync(comp) && fs.readdirSync(comp).length >= 20;
            } catch (_) { return false; }
        })()
    );
    if (cloneLooksComplete) {
        log("ESP-IDF already cloned (verified)");
    } else {
        if (fs.existsSync(idf)) {
            log("Partial / corrupted ESP-IDF clone detected — wiping and starting fresh");
            try { fs.rmSync(idf, { recursive: true, force: true }); } catch (_) {}
        }
        if (chip.includes("8266")) {
            log("Downloading ESP8266 RTOS SDK (pinned)...");
            const r = await cloneAtSha("esp8266", idf, true, run, log);
            if (!r.ok) { emit.stageError("clone-idf", "pinned SDK clone/verify failed"); return false; }
        } else {
            log("Downloading ESP-IDF v5.4 (pinned; this may take several minutes)...");
            const r = await cloneAtSha("esp-idf", idf, true, run, log);
            if (!r.ok) { emit.stageError("clone-idf", "pinned SDK clone/verify failed"); return false; }
        }
    }
    emit.stageDone("clone-idf");

    emit.stage("install-idf");
    // Prepend bundled Python to PATH so install.sh creates the venv with 3.12+.
    // Apple's stock Python is 3.9 which has importlib.metadata bugs with
    // dotted package names (e.g. "ruamel.yaml") that break ESP-IDF's
    // dependency checker — using 3.12 avoids the whole class of issues.
    // On macOS, also wipe any pre-existing python_env that was built against
    // the wrong Python — install.sh will re-create it under bundled Python.
    if (process.platform === "darwin") {
        const venvRoot = path.join(os.homedir(), ".espressif", "python_env");
        if (fs.existsSync(venvRoot)) {
            for (const sub of fs.readdirSync(venvRoot)) {
                const m = sub.match(/_py(\d+)\.(\d+)_env$/);
                if (m) {
                    const major = +m[1], minor = +m[2];
                    if (major < 3 || (major === 3 && minor < 10)) {
                        log(`Removing stale ESP-IDF venv (py${major}.${minor}): ${sub}`);
                        try { fs.rmSync(path.join(venvRoot, sub), { recursive: true, force: true }); } catch (_) {}
                    }
                }
            }
        }
    }
    const pathPrefix = py ? `${path.dirname(py)}${path.delimiter}` : "";
    const installCmd = chip.includes("8266")
        ? `export PATH="${pathPrefix}$PATH" && cd "${idf}" && ./install.sh 2>&1`
        : `export PATH="${pathPrefix}$PATH" && cd "${idf}" && ./install.sh esp32 2>&1`;
    log("Installing ESP-IDF toolchain (this may take several minutes)...");
    const installResult = await run(installCmd, log);
    if (!installResult.ok) { emit.stageError("install-idf", "install.sh failed"); return false; }
    emit.stageDone("install-idf");

    emit.stage("env");
    log("Toolchain ready");
    emit.stageDone("env");

    return true;
}

// ================================================================
// Public API
// ================================================================

async function ensureToolchain(chip, legacy) {
    const emit = makeEmit(legacy);
    const log = emit.log;
    const c = chip.toLowerCase();
    if (c.includes("rp2040") || c.includes("pico")) {
        return await ensureRP2040(emit);
    }
    if (c.includes("8266") || c.includes("esp32") || c.includes("esp")) {
        return await ensureEspIdf(c, emit);
    }
    if (c.includes("stm32")) {
        emit.stage("check"); emit.stageDone("check");

        // ARM GCC: Linux uses apt; macOS uses the portable Arm tarball
        // (same as RP2040 path).
        emit.stage("arm-gcc");
        if (process.platform === "linux") {
            if (!hasCommand("arm-none-eabi-gcc")) {
                log("Installing ARM GCC for STM32 via apt...");
                const r = await run("sudo apt-get install -y gcc-arm-none-eabi 2>&1", log);
                if (!r.ok) { emit.stageError("arm-gcc", "apt install failed"); return false; }
            } else {
                log("ARM GCC already installed");
            }
        } else if (process.platform === "darwin") {
            const ok = await ensureArmGcc(emit);
            if (!ok) { emit.stageError("arm-gcc", "download failed"); return false; }
        } else {
            log("ARM GCC auto-install not implemented on this platform.");
            if (!hasCommand("arm-none-eabi-gcc")) {
                emit.stageError("arm-gcc", "not installed");
                return false;
            }
        }
        emit.stageDone("arm-gcc");

        // OpenOCD: Linux via apt. macOS has no portable binary in the
        // mirror yet — fail honestly with a manual-install hint instead
        // of silently lying that we installed it.
        emit.stage("openocd");
        if (process.platform === "linux") {
            if (!hasCommand("openocd")) {
                log("Installing OpenOCD via apt...");
                const r = await run("sudo apt-get install -y openocd 2>&1", log);
                if (!r.ok) { emit.stageError("openocd", "apt install failed"); return false; }
            } else {
                log("OpenOCD already installed");
            }
            emit.stageDone("openocd");
        } else if (process.platform === "darwin") {
            if (hasCommand("openocd")) {
                log("OpenOCD already installed (probably via Homebrew)");
                emit.stageDone("openocd");
            } else {
                log("OpenOCD must be installed manually on macOS.");
                log("Recommended: brew install open-ocd");
                log("Then re-run Check.");
                emit.stageError("openocd", "manual install required (brew install open-ocd)");
                return false;
            }
        } else {
            log("OpenOCD auto-install not implemented on this platform.");
            if (!hasCommand("openocd")) {
                emit.stageError("openocd", "not installed");
                return false;
            }
            emit.stageDone("openocd");
        }

        emit.stage("env"); emit.stageDone("env");
        return true;
    }
    log("Unknown chip: " + chip);
    return false;
}

// Deep readiness check. Returns { ready: bool, reason: string|null, missing: [] }.
// Verifies actual binaries exist — not just marker files — so partial,
// interrupted, or corrupted installs are detected as not-ready.
function diagnoseToolchain(chip) {
    const c = chip.toLowerCase();
    const missing = [];

    if (c.includes("rp2040") || c.includes("pico")) {
        // ARM GCC: PATH on Linux/Windows; portable on macOS
        const hasArm = hasCommand("arm-none-eabi-gcc") ||
                       (process.platform === "darwin" && !!armGccBin());
        if (!hasArm) missing.push("arm-none-eabi-gcc (ARM GCC compiler)");
        // cmake: PATH on Linux/Windows; portable on macOS
        const hasCmake = hasCommand("cmake") ||
                         (process.platform === "darwin" && !!cmakeBin());
        if (!hasCmake) missing.push("cmake");
        // ninja is required for Pico SDK builds with Ninja generator
        if (process.platform === "darwin" && !ninjaBin())
            missing.push("ninja (portable, ~/.volt/toolchains/ninja)");
        const sdk = picoSdkPath();
        if (!fs.existsSync(path.join(sdk, "pico_sdk_init.cmake")))
            missing.push("pico-sdk (clone incomplete or absent)");
        if (fs.existsSync(sdk) && !fs.existsSync(path.join(sdk, "src", "CMakeLists.txt")))
            missing.push("pico-sdk/src (partial clone)");
    }
    else if (c.includes("esp32") || c.includes("esp")) {
        const idf = espIdfPath(c);

        if (!fs.existsSync(path.join(idf, "export.sh")))
            missing.push("ESP-IDF (clone incomplete or absent)");
        // Verify clone actually finished — components/ should be populated
        if (fs.existsSync(idf)) {
            const comp = path.join(idf, "components");
            if (!fs.existsSync(comp) || fs.readdirSync(comp).length < 20)
                missing.push("ESP-IDF components/ (partial clone)");
            // tools/idf.py is the entry point we shell into; if missing, idf is broken
            if (!fs.existsSync(path.join(idf, "tools", "idf.py")))
                missing.push("tools/idf.py (ESP-IDF clone broken)");
        }

        if (process.platform === "darwin") {
            if (!cmakeBin()) missing.push("cmake (portable, ~/.volt/toolchains/cmake)");
            if (!ninjaBin()) missing.push("ninja (portable, ~/.volt/toolchains/ninja)");
        }

        // venv must exist AND be on python>=3.10
        const venvBase = path.join(os.homedir(), ".espressif", "python_env");
        if (!fs.existsSync(venvBase)) {
            missing.push("~/.espressif/python_env (Python venv not created)");
        } else {
            let foundGoodVenv = false;
            try {
                for (const sub of fs.readdirSync(venvBase)) {
                    const m = sub.match(/_py(\d+)\.(\d+)_env$/);
                    if (!m) continue;
                    const major = +m[1], minor = +m[2];
                    if (major > 3 || (major === 3 && minor >= 10)) {
                        // Verify the python binary actually exists in the venv
                        if (fs.existsSync(path.join(venvBase, sub, "bin", "python"))) {
                            foundGoodVenv = true;
                            break;
                        }
                    }
                }
            } catch (_) {}
            if (!foundGoodVenv) missing.push("ESP-IDF Python venv (need py>=3.10)");
        }

        // Verify the cross-compiler is actually installed.
        // Modern ESP-IDF uses a unified xtensa-esp-elf-gcc + chip-specific symlinks.
        const toolsDir = path.join(os.homedir(), ".espressif", "tools");
        if (!hasEspCompiler(toolsDir, c)) {
            missing.push("xtensa cross-compiler (~/.espressif/tools — install incomplete)");
        }
    }
    else if (c.includes("stm32")) {
        if (!hasCommand("arm-none-eabi-gcc"))
            missing.push("arm-none-eabi-gcc");
        if (!hasCommand("openocd"))
            missing.push("openocd");
    }
    else {
        return { ready: false, reason: `Unknown chip: ${chip}`, missing: [] };
    }

    return {
        ready: missing.length === 0,
        reason: missing.length ? missing[0] : null,
        missing,
    };
}

// Walk ~/.espressif/tools looking for a working xtensa- or riscv- gcc binary.
// We don't pin a version — ESP-IDF v5.x ships different toolchain folder names.
function hasEspCompiler(toolsDir, chip) {
    if (!fs.existsSync(toolsDir)) return false;
    const wantPrefix = chip.includes("c3") || chip.includes("c6") || chip.includes("h2")
        ? "riscv32-esp-elf"   // RISC-V chips
        : "xtensa-esp";        // ESP32 / S2 / S3 — xtensa
    try {
        for (const folder of fs.readdirSync(toolsDir)) {
            if (!folder.startsWith(wantPrefix)) continue;
            const base = path.join(toolsDir, folder);
            // Structure is tools/<name>/<version>/<name>/bin/<binary>
            for (const ver of fs.readdirSync(base)) {
                const bin = path.join(base, ver, folder, "bin");
                if (!fs.existsSync(bin)) continue;
                for (const f of fs.readdirSync(bin)) {
                    if (f.endsWith("-gcc") || f.endsWith("-gcc.exe")) return true;
                }
            }
        }
    } catch (_) {}
    return false;
}

// Back-compat boolean wrapper.
function isToolchainReady(chip) {
    return diagnoseToolchain(chip).ready;
}

// Repair: wipe just enough state that ensureToolchain will recreate it.
// Returns the list of dirs that were removed.
function repairToolchain(chip) {
    const c = chip.toLowerCase();
    const removed = [];
    const rm = (p) => {
        if (p && fs.existsSync(p)) {
            try { fs.rmSync(p, { recursive: true, force: true }); removed.push(p); } catch (_) {}
        }
    };
    if (c.includes("rp2040") || c.includes("pico")) {
        rm(picoSdkPath());
        rm(path.join(TOOLCHAINS_DIR, "picotool"));
        if (process.platform === "darwin") {
            rm(path.join(TOOLCHAINS_DIR, "arm-gnu-toolchain"));
            rm(path.join(TOOLCHAINS_DIR, "cmake"));
            rm(path.join(TOOLCHAINS_DIR, "ninja"));
        }
    } else if (c.includes("esp32") || c.includes("esp")) {
        rm(espIdfPath(c));
        rm(path.join(os.homedir(), ".espressif"));
        if (process.platform === "darwin") {
            // Only wipe cmake/ninja if THIS chip is the only consumer — for
            // simplicity we always wipe; ensureCmakeNinja is fast to redo.
            rm(path.join(TOOLCHAINS_DIR, "cmake"));
            rm(path.join(TOOLCHAINS_DIR, "ninja"));
        }
    }
    return removed;
}

// Free-disk check before kicking off a large install. Returns bytes free in
// the target directory's filesystem, or null if not detectable.
function freeDiskBytes(dir) {
    try {
        const out = execSync(`df -k "${dir.replace(/"/g, '\\"')}" | tail -1`, { encoding: "utf-8" });
        // POSIX df -k columns: filesystem 1K-blocks used avail capacity ...
        const cols = out.trim().split(/\s+/);
        // avail is col 3 (Linux) or col 3 (macOS); be defensive
        const availKB = Number(cols[3]);
        return isFinite(availKB) ? availKB * 1024 : null;
    } catch (_) { return null; }
}

module.exports = {
    ensureToolchain, isToolchainReady, diagnoseToolchain, repairToolchain,
    freeDiskBytes,
    picoSdkPath, espIdfPath, TOOLCHAINS_DIR,
    bundledPythonBin, cmakeBin, ninjaBin, picotoolBin, buildPathPrefix,
};
