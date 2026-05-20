// Toolchain auto-setup — downloads and configures build tools per chip
// Ported from Tauri toolchain.rs

const { execSync, spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");

const TOOLCHAINS_DIR = path.join(os.homedir(), ".volt", "toolchains");

function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); }

function hasCommand(name) {
    try {
        execSync(`which ${name}`, { stdio: "ignore" });
        return true;
    } catch { return false; }
}

function run(cmd, log) {
    if (log) log(cmd);
    try {
        const out = execSync(cmd, { timeout: 600000, maxBuffer: 10 * 1024 * 1024 });
        return { ok: true, output: out.toString() };
    } catch (e) {
        return { ok: false, output: e.stderr ? e.stderr.toString() : e.message };
    }
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
    const emit = {
        log: (msg) => {
            logFn(msg);
            // Detect progress patterns in the message
            if (!currentStageId) return;
            const s = String(msg);
            // git: "Receiving objects:  33% (15234/46123)"
            let m = s.match(/(?:Receiving objects|Resolving deltas):\s+(\d+)%\s*\(([\d.]+)\/([\d.]+)\)/);
            if (m) { emit.progress(currentStageId, +m[1], `git: ${m[2]} / ${m[3]} objects`); return; }
            // curl/wget: " 45%  300M/700M"
            m = s.match(/(\d+)%\s+([\d.]+[KMG]?)\s*\/\s*([\d.]+[KMG]?)/);
            if (m) { emit.progress(currentStageId, +m[1], `${m[2]} / ${m[3]}`); return; }
            // apt: "Reading package lists..." / "Setting up <pkg>"
            if (/^Setting up\b/.test(s)) emit.progress(currentStageId, 75, s.slice(0, 80));
            if (/^Reading package lists/.test(s)) emit.progress(currentStageId, 10, s.slice(0, 80));
            if (/^Unpacking\b/.test(s))   emit.progress(currentStageId, 50, s.slice(0, 80));
        },
        stage: (id) => {
            currentStageId = id;
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

function ensureRP2040(legacy) {
    const emit = makeEmit(legacy);
    const log = emit.log;
    ensureDir(TOOLCHAINS_DIR);

    emit.stage("check");
    log("Checking RP2040 prerequisites...");
    emit.stageDone("check");

    // 1. ARM GCC
    emit.stage("arm-gcc");
    if (!hasCommand("arm-none-eabi-gcc")) {
        log("Installing ARM GCC toolchain...");
        const r = run("sudo apt-get install -y gcc-arm-none-eabi libnewlib-arm-none-eabi 2>&1", log);
        if (!r.ok) {
            log("ERROR: Failed to install ARM GCC. Run manually: sudo apt install gcc-arm-none-eabi");
            emit.stageError("arm-gcc", "apt install failed");
            return false;
        }
        log("ARM GCC installed");
    } else {
        log("ARM GCC already installed");
    }
    emit.stageDone("arm-gcc");

    // 2. cmake
    emit.stage("cmake");
    if (!hasCommand("cmake")) {
        log("Installing cmake...");
        const r = run("sudo apt-get install -y cmake 2>&1", log);
        if (!r.ok) {
            emit.stageError("cmake", "apt install failed");
            return false;
        }
    } else {
        log("cmake already installed");
    }
    emit.stageDone("cmake");

    // 3. Pico SDK
    emit.stage("clone-sdk");
    const sdk = picoSdkPath();
    if (!fs.existsSync(path.join(sdk, "pico_sdk_init.cmake"))) {
        log("Downloading Raspberry Pi Pico SDK...");
        const r = run(`git clone --depth=1 --recurse-submodules --shallow-submodules https://github.com/raspberrypi/pico-sdk.git "${sdk}" 2>&1`, log);
        if (!r.ok) {
            emit.stageError("clone-sdk", "git clone failed (check internet)");
            return false;
        }
        log("Pico SDK ready");
    } else {
        log("Pico SDK already present");
    }
    emit.stageDone("clone-sdk");

    // 4. picotool
    emit.stage("picotool");
    if (!hasCommand("picotool")) {
        log("Installing picotool for direct flashing...");
        if (!installPicotool(emit)) {
            log("picotool install failed — you can still flash via BOOTSEL mode");
            emit.stageError("picotool", "build failed (BOOTSEL still works)");
        } else {
            emit.stageDone("picotool");
        }
    } else {
        log("picotool already installed");
        emit.stageDone("picotool");
    }

    // 5. udev rules
    emit.stage("udev");
    setupRP2040Udev(emit);
    emit.stageDone("udev");

    return true;
}

function installPicotool(emit) {
    const log = emit && emit.log ? emit.log : (emit || (() => {}));
    // Need libusb
    run("sudo apt-get install -y libusb-1.0-0-dev 2>&1", log);

    const picotoolDir = path.join(TOOLCHAINS_DIR, "picotool-build");
    ensureDir(picotoolDir);

    const srcDir = path.join(picotoolDir, "src");
    if (!fs.existsSync(path.join(srcDir, "CMakeLists.txt"))) {
        log("Downloading picotool source...");
        const r = run(`git clone --depth=1 https://github.com/raspberrypi/picotool.git "${srcDir}" 2>&1`, log);
        if (!r.ok) return false;
    }

    const buildDir = path.join(picotoolDir, "build");
    ensureDir(buildDir);
    const sdk = picoSdkPath();

    log("Configuring picotool...");
    let r = run(`cmake -S "${srcDir}" -B "${buildDir}" -DPICO_SDK_PATH="${sdk}" -DCMAKE_BUILD_TYPE=Release 2>&1`, log);
    if (!r.ok) return false;

    log("Building picotool (takes ~30s)...");
    r = run(`cmake --build "${buildDir}" --parallel 2>&1`, log);
    if (!r.ok) return false;

    // Install
    r = run(`sudo cp "${buildDir}/picotool" /usr/local/bin/picotool 2>&1`);
    if (!r.ok) {
        // Try ~/.local/bin
        const localBin = path.join(os.homedir(), ".local", "bin");
        ensureDir(localBin);
        try { fs.copyFileSync(path.join(buildDir, "picotool"), path.join(localBin, "picotool")); }
        catch { return false; }
    }

    log("picotool installed");
    setupRP2040Udev(log);
    return true;
}

function setupRP2040Udev(emit) {
    const log = emit && emit.log ? emit.log : (emit || (() => {}));
    const rulesPath = "/etc/udev/rules.d/99-pico.rules";
    if (fs.existsSync(rulesPath)) return;

    log("Setting up USB permissions for Pico...");
    const rules = '# Raspberry Pi Pico\nSUBSYSTEM=="usb", ATTRS{idVendor}=="2e8a", TAG+="uaccess"\nSUBSYSTEM=="tty", ATTRS{idVendor}=="2e8a", MODE="0666"\n';
    const tmp = path.join(os.tmpdir(), "99-pico.rules");
    fs.writeFileSync(tmp, rules);

    const r = run(`sudo cp "${tmp}" "${rulesPath}" && sudo udevadm control --reload-rules && sudo udevadm trigger 2>&1`);
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

function ensureEspIdf(chip, legacy) {
    const emit = makeEmit(legacy);
    const log = emit.log;
    ensureDir(TOOLCHAINS_DIR);

    emit.stage("check");
    log(`Checking ${chip} prerequisites...`);
    emit.stageDone("check");

    const idf = espIdfPath(chip);
    if (fs.existsSync(path.join(idf, "export.sh")) && fs.existsSync(path.join(idf, "install.sh"))) {
        // Already cloned — skip clone but still go through install
        emit.stage("deps"); emit.stageDone("deps");
        emit.stage("clone-idf"); log("ESP-IDF already cloned"); emit.stageDone("clone-idf");
    } else {
        // System deps (apt/brew prerequisites). Best-effort on Linux.
        emit.stage("deps");
        if (process.platform === "linux") {
            run("sudo apt-get install -y git wget flex bison gperf python3 python3-pip cmake ninja-build ccache libffi-dev libssl-dev dfu-util libusb-1.0-0 2>&1", log);
        }
        emit.stageDone("deps");

        emit.stage("clone-idf");
        if (chip.includes("8266")) {
            log("Downloading ESP8266 RTOS SDK...");
            const r = run(`git clone --depth=1 --recurse-submodules --shallow-submodules --progress https://github.com/espressif/ESP8266_RTOS_SDK.git "${idf}" 2>&1`, log);
            if (!r.ok) { emit.stageError("clone-idf", "git clone failed"); return false; }
        } else {
            log("Downloading ESP-IDF v5.4 (this may take several minutes)...");
            const r = run(`git clone --depth=1 -b v5.4 --recurse-submodules --shallow-submodules --progress https://github.com/espressif/esp-idf.git "${idf}" 2>&1`, log);
            if (!r.ok) { emit.stageError("clone-idf", "git clone failed"); return false; }
        }
        emit.stageDone("clone-idf");
    }

    emit.stage("install-idf");
    if (chip.includes("8266")) {
        log("Installing ESP8266 SDK dependencies...");
        const r = run(`cd "${idf}" && ./install.sh 2>&1`, log);
        if (!r.ok) { emit.stageError("install-idf", "install.sh failed"); return false; }
    } else {
        log("Installing ESP-IDF toolchain (this may take several minutes)...");
        const r = run(`cd "${idf}" && ./install.sh esp32 2>&1`, log);
        if (!r.ok) { emit.stageError("install-idf", "install.sh failed"); return false; }
    }
    emit.stageDone("install-idf");

    emit.stage("env");
    log("Toolchain ready");
    emit.stageDone("env");

    return true;
}

// ================================================================
// Public API
// ================================================================

function ensureToolchain(chip, legacy) {
    const emit = makeEmit(legacy);
    const log = emit.log;
    const c = chip.toLowerCase();
    if (c.includes("rp2040") || c.includes("pico")) {
        return ensureRP2040(emit);
    }
    if (c.includes("8266") || c.includes("esp32") || c.includes("esp")) {
        return ensureEspIdf(c, emit);
    }
    if (c.includes("stm32")) {
        emit.stage("check"); emit.stageDone("check");
        emit.stage("arm-gcc");
        if (!hasCommand("arm-none-eabi-gcc")) {
            log("Installing ARM GCC for STM32...");
            const r = run("sudo apt-get install -y gcc-arm-none-eabi 2>&1", log);
            if (!r.ok) { emit.stageError("arm-gcc", "apt install failed"); return false; }
        }
        emit.stageDone("arm-gcc");
        emit.stage("openocd"); log("OpenOCD setup pending"); emit.stageDone("openocd");
        emit.stage("env"); emit.stageDone("env");
        return true;
    }
    log("Unknown chip: " + chip);
    return false;
}

function isToolchainReady(chip) {
    const c = chip.toLowerCase();
    if (c.includes("rp2040") || c.includes("pico")) {
        return hasCommand("arm-none-eabi-gcc") && hasCommand("cmake") &&
            fs.existsSync(path.join(picoSdkPath(), "pico_sdk_init.cmake"));
    }
    if (c.includes("esp32") || c.includes("esp")) {
        return fs.existsSync(path.join(espIdfPath(c), "export.sh"));
    }
    if (c.includes("stm32")) {
        return hasCommand("arm-none-eabi-gcc");
    }
    return false;
}

module.exports = { ensureToolchain, isToolchainReady, picoSdkPath, espIdfPath, TOOLCHAINS_DIR };
