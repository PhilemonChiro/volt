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

// ================================================================
// RP2040 — Pico SDK + ARM GCC + picotool
// ================================================================

function picoSdkPath() {
    return path.join(TOOLCHAINS_DIR, "pico-sdk");
}

function ensureRP2040(log) {
    ensureDir(TOOLCHAINS_DIR);

    // 1. ARM GCC
    if (!hasCommand("arm-none-eabi-gcc")) {
        log("Installing ARM GCC toolchain...");
        const r = run("sudo apt-get install -y gcc-arm-none-eabi libnewlib-arm-none-eabi 2>&1", log);
        if (!r.ok) {
            log("ERROR: Failed to install ARM GCC. Run manually: sudo apt install gcc-arm-none-eabi");
            return false;
        }
        log("ARM GCC installed");
    }

    // 2. cmake
    if (!hasCommand("cmake")) {
        log("Installing cmake...");
        const r = run("sudo apt-get install -y cmake 2>&1", log);
        if (!r.ok) {
            log("ERROR: Failed to install cmake");
            return false;
        }
    }

    // 3. Pico SDK
    const sdk = picoSdkPath();
    if (!fs.existsSync(path.join(sdk, "pico_sdk_init.cmake"))) {
        log("Downloading Raspberry Pi Pico SDK...");
        const r = run(`git clone --depth=1 --recurse-submodules --shallow-submodules https://github.com/raspberrypi/pico-sdk.git "${sdk}" 2>&1`, log);
        if (!r.ok) {
            log("ERROR: Failed to download Pico SDK. Check internet connection.");
            return false;
        }
        log("Pico SDK ready");
    }

    // 4. picotool
    if (!hasCommand("picotool")) {
        log("Installing picotool for direct flashing...");
        if (!installPicotool(log)) {
            log("picotool install failed — you can still flash via BOOTSEL mode");
        }
    }

    return true;
}

function installPicotool(log) {
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

function setupRP2040Udev(log) {
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
    // Check common location first
    const devPath = path.join(os.homedir(), "esp", "esp-idf");
    if (fs.existsSync(devPath)) return devPath;
    return path.join(TOOLCHAINS_DIR, "esp-idf");
}

function ensureEspIdf(chip, log) {
    ensureDir(TOOLCHAINS_DIR);

    const idf = espIdfPath(chip);
    if (fs.existsSync(path.join(idf, "export.sh"))) {
        return true;
    }

    if (chip.includes("8266")) {
        log("Downloading ESP8266 RTOS SDK...");
        const r = run(`git clone --depth=1 --recurse-submodules --shallow-submodules https://github.com/espressif/ESP8266_RTOS_SDK.git "${idf}" 2>&1`, log);
        if (!r.ok) {
            log("ERROR: Failed to download ESP8266 SDK");
            return false;
        }
        log("Installing ESP8266 SDK dependencies...");
        run(`cd "${idf}" && ./install.sh 2>&1`, log);
    } else {
        log("Downloading ESP-IDF v5.4 (this may take several minutes)...");
        const r = run(`git clone --depth=1 -b v5.4 --recurse-submodules --shallow-submodules https://github.com/espressif/esp-idf.git "${idf}" 2>&1`, log);
        if (!r.ok) {
            log("ERROR: Failed to download ESP-IDF");
            return false;
        }

        log("Installing ESP-IDF toolchain (this may take several minutes)...");
        const install = run(`cd "${idf}" && ./install.sh esp32 2>&1`, log);
        if (!install.ok) {
            log("ERROR: ESP-IDF install.sh failed");
            return false;
        }
    }

    log("Toolchain ready");
    return true;
}

// ================================================================
// Public API
// ================================================================

function ensureToolchain(chip, log) {
    const c = chip.toLowerCase();
    if (c.includes("rp2040") || c.includes("pico")) {
        return ensureRP2040(log);
    }
    if (c.includes("8266") || c.includes("esp32") || c.includes("esp")) {
        return ensureEspIdf(c, log);
    }
    if (c.includes("stm32")) {
        // STM32 — just needs ARM GCC
        if (!hasCommand("arm-none-eabi-gcc")) {
            log("Installing ARM GCC for STM32...");
            const r = run("sudo apt-get install -y gcc-arm-none-eabi 2>&1", log);
            if (!r.ok) {
                log("ERROR: Failed to install ARM GCC");
                return false;
            }
        }
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
