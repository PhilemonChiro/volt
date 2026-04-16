// Builder — compile C, flash to device
// Ported from Tauri runner.rs

const { execSync, spawn, spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");
const toolchain = require("./toolchain");

function frameworkDir(chip) {
    const c = chip.toLowerCase();
    const platform = c.includes("rp2040") || c.includes("pico") ? "rp2040" : "esp32";
    const dev = path.join(__dirname, "..", "..", "..", "framework", platform);
    if (fs.existsSync(dev)) return dev;
    return path.join(os.homedir(), ".volt", "sdk", "framework", platform);
}

function readChipFromToml(projectPath) {
    const toml = path.join(projectPath, "volt.toml");
    if (!fs.existsSync(toml)) return "esp32";
    const m = fs.readFileSync(toml, "utf-8").match(/chip\s*=\s*"([^"]+)"/);
    return m ? m[1] : "esp32";
}

// ============================================================
// RP2040 build + flash
// ============================================================

function buildRP2040(projectPath, log) {
    const fw = frameworkDir("rp2040");
    if (!fs.existsSync(fw)) {
        log("error", "RP2040 framework not found at " + fw);
        return false;
    }

    // Copy generated main.c
    const src = path.join(projectPath, "build", "main.c");
    const dst = path.join(fw, "main", "main.c");
    if (!fs.existsSync(src)) {
        log("error", "No main.c in build/ — compile first");
        return false;
    }
    fs.copyFileSync(src, dst);

    const buildDir = path.join(fw, "build");
    fs.mkdirSync(buildDir, { recursive: true });
    const sdk = toolchain.picoSdkPath();

    // CMake configure (if not done yet)
    if (!fs.existsSync(path.join(buildDir, "Makefile")) &&
        !fs.existsSync(path.join(buildDir, "build.ninja"))) {
        log("build", "Configuring CMake for RP2040...");
        const r = runSync(`cmake -S "${fw}" -B "${buildDir}" -DPICO_SDK_PATH="${sdk}"`, sdk);
        if (!r.ok) { log("error", "CMake configure failed:\n" + r.output.substring(0, 500)); return false; }
    }

    // Build
    log("build", "Building RP2040 firmware...");
    const r = runSync(`cmake --build "${buildDir}" --parallel`, sdk);

    // Check for actual build output (.uf2 or .elf)
    const uf2 = path.join(buildDir, "volt-rp2040.uf2");
    const elf = path.join(buildDir, "volt-rp2040.elf");

    if (!r.ok && !fs.existsSync(uf2) && !fs.existsSync(elf)) {
        // Real failure — find actual error lines (skip info/warning)
        const errorLines = r.output.split("\n").filter(l =>
            l.includes("error:") || l.includes("Error") || l.includes("fatal")
        );
        const msg = errorLines.length > 0 ? errorLines.join("\n") : r.output.substring(0, 500);
        log("error", "Build failed:\n" + msg);
        return false;
    }

    if (fs.existsSync(uf2)) {
        const size = fs.statSync(uf2).size;
        log("build", `Build complete — ${(size / 1024).toFixed(0)}KB firmware`);
    } else {
        log("build", "Build complete");
    }
    return true;
}

function flashRP2040(projectPath, port, log) {
    const fw = frameworkDir("rp2040");
    const uf2 = path.join(fw, "build", "volt-rp2040.uf2");

    if (!fs.existsSync(uf2)) {
        log("error", "Build did not produce .uf2 file");
        return false;
    }

    // Try picotool first
    if (hasCommand("picotool")) {
        log("flash", "Flashing with picotool...");
        let r = runSync(`picotool load "${uf2}" -f`);
        if (r.ok) {
            log("flash", "Rebooting device...");
            runSync("picotool reboot");
            return true;
        }
        // Try with sudo
        r = runSync(`sudo picotool load "${uf2}" -f`);
        if (r.ok) {
            runSync("sudo picotool reboot");
            log("info", "Flashed with sudo. Fix USB permissions to avoid this next time.");
            return true;
        }
    }

    // Fallback: copy to mounted BOOTSEL drive
    const mount = findPicoMount();
    if (mount) {
        log("flash", "Copying .uf2 to Pico (BOOTSEL mode)...");
        try {
            fs.copyFileSync(uf2, path.join(mount, "volt-rp2040.uf2"));
            log("flash", "Firmware copied. Pico will reboot.");
            return true;
        } catch (e) {
            log("error", "Cannot copy .uf2: " + e.message);
            return false;
        }
    }

    log("error", "Cannot flash: picotool failed and Pico not in BOOTSEL mode. Hold BOOTSEL, plug in, then Run again.");
    return false;
}

function findPicoMount() {
    const bases = ["/media", "/mnt", "/run/media"];
    for (const base of bases) {
        if (!fs.existsSync(base)) continue;
        try {
            for (const entry of fs.readdirSync(base)) {
                const p = path.join(base, entry);
                if (!fs.statSync(p).isDirectory()) continue;
                // Check subdirs (e.g. /media/username/RPI-RP2)
                try {
                    for (const sub of fs.readdirSync(p)) {
                        if (sub.includes("RPI-RP2")) return path.join(p, sub);
                    }
                } catch {}
                if (entry.includes("RPI-RP2")) return p;
            }
        } catch {}
    }
    return null;
}

// ============================================================
// ESP32 build + flash
// ============================================================

function buildESP32(projectPath, chip, log) {
    const fw = frameworkDir("esp32");
    if (!fs.existsSync(fw)) {
        log("error", "ESP32 framework not found at " + fw);
        return false;
    }

    const src = path.join(projectPath, "build", "main.c");
    const dst = path.join(fw, "main", "main.c");
    if (!fs.existsSync(src)) {
        log("error", "No main.c in build/ — compile first");
        return false;
    }
    fs.copyFileSync(src, dst);

    const idf = toolchain.espIdfPath(chip);
    log("build", "Building ESP32 firmware...");
    const r = runSync(`bash -c "source ${idf}/export.sh >/dev/null 2>&1 && cd ${fw} && idf.py build 2>&1"`);
    if (!r.ok) { log("error", "Build failed:\n" + r.output.substring(0, 500)); return false; }

    log("build", "Build complete");
    return true;
}

function flashESP32(projectPath, port, chip, log) {
    const fw = frameworkDir("esp32");
    const idf = toolchain.espIdfPath(chip);

    log("flash", `Flashing to ${port}...`);
    const r = runSync(`bash -c "source ${idf}/export.sh >/dev/null 2>&1 && cd ${fw} && idf.py -p ${port} flash 2>&1"`);
    if (!r.ok) { log("error", "Flash failed:\n" + r.output.substring(0, 500)); return false; }

    log("flash", "Flash complete");
    return true;
}

// ============================================================
// Helpers
// ============================================================

function runSync(cmd, envPicoSdk) {
    const env = { ...process.env };
    if (envPicoSdk) env.PICO_SDK_PATH = envPicoSdk;

    const result = spawnSync("bash", ["-c", cmd], {
        timeout: 300000,
        maxBuffer: 10 * 1024 * 1024,
        env,
        encoding: "utf-8",
    });

    const stdout = result.stdout || "";
    const stderr = result.stderr || "";
    const ok = result.status === 0;

    return { ok, output: stdout + stderr, status: result.status };
}

function hasCommand(name) {
    try { execSync(`which ${name}`, { stdio: "ignore" }); return true; }
    catch { return false; }
}

function waitForPort(prefix, timeoutMs) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
        try {
            const entries = fs.readdirSync("/dev");
            const found = entries.find(e => e.startsWith(prefix));
            if (found) return "/dev/" + found;
        } catch {}
        spawnSync("sleep", ["0.5"]);
    }
    return null;
}

module.exports = {
    buildRP2040, flashRP2040,
    buildESP32, flashESP32,
    frameworkDir, readChipFromToml, waitForPort,
};
