// Builder — compile C, build firmware, flash to device
// Real-time streaming with progress parsing (ported from Tauri runner.rs)

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

// ============================================================
// Stream a shell command, parse progress, emit events
// ============================================================

function streamCommand(cmd, stage, emit, envExtra) {
    return new Promise((resolve) => {
        const env = { ...process.env, ...envExtra };
        const child = spawn("bash", ["-c", cmd], { env, stdio: ["ignore", "pipe", "pipe"] });

        const pctRange = { build: [30, 60], flash: [65, 95] };
        const [pctStart, pctEnd] = pctRange[stage] || [0, 100];

        // CMake configure has no [N/M] progress, so we approximate from the
        // sequence of "-- ..." status lines it prints. Each recognized milestone
        // bumps the percentage a little + relays the line as a sub-status.
        let cmakeConfigureSeen = 0;
        const CMAKE_MILESTONES = [
            { re: /-- The C compiler identification/i,        label: "Detecting C compiler" },
            { re: /-- The CXX compiler identification/i,      label: "Detecting C++ compiler" },
            { re: /-- Detecting C compile features/i,         label: "Detecting compiler features" },
            { re: /-- Check for working C compiler/i,         label: "Checking C compiler" },
            { re: /-- Found Python/i,                         label: "Found Python" },
            { re: /-- Found Git/i,                            label: "Found Git" },
            { re: /-- Build type:/i,                          label: "Setting build type" },
            { re: /-- Configuring done/i,                     label: "Configuring done" },
            { re: /-- Generating done/i,                      label: "Generating done" },
            { re: /-- Build files have been written/i,        label: "Build files written" },
        ];

        function processLine(raw) {
            const line = raw.toString().trim();
            if (!line) return;

            // Filter noise
            if (isBuildNoise(line)) return;

            // Parse ninja/make [N/M] progress
            const stepMatch = line.match(/\[(\d+)\/(\d+)\]\s*(.*)/);
            if (stepMatch) {
                const current = parseInt(stepMatch[1]);
                const total = parseInt(stepMatch[2]);
                const desc = stepMatch[3] || "";
                const pct = pctStart + Math.round((current / total) * (pctEnd - pctStart));

                let label = `Building (${current}/${total})`;
                if (desc.includes("ompil")) label = `Compiling (${current}/${total})`;
                else if (desc.includes("inking")) label = `Linking (${current}/${total})`;
                else if (desc.includes("enerating")) label = `Generating (${current}/${total})`;

                emit(stage, label, pct);
                return;
            }

            // CMake configure milestones — provide feedback during the silent
            // 5-15s window before ninja [N/M] lines start showing.
            for (const { re, label } of CMAKE_MILESTONES) {
                if (re.test(line)) {
                    cmakeConfigureSeen++;
                    // Climb gently from pctStart toward halfway to pctEnd
                    const budget = Math.max(1, Math.floor((pctEnd - pctStart) / 4));
                    const pct = Math.min(
                        pctStart + budget,
                        pctStart + Math.ceil((cmakeConfigureSeen / CMAKE_MILESTONES.length) * budget),
                    );
                    emit(stage, `CMake: ${label}`, pct);
                    return;
                }
            }

            // Parse esptool flash progress: "Writing at 0x... (N %)" only during flash stage
            if (stage === "flash" && line.includes("Writing at")) {
                const flashMatch = line.match(/\((\d+)\s*%\)/);
                if (flashMatch) {
                    const flashPct = parseInt(flashMatch[1]);
                    const pct = pctStart + Math.round((flashPct / 100) * (pctEnd - pctStart));
                    emit(stage, `Flashing... ${flashPct}%`, pct);
                    return;
                }
            }

            // esptool connection states
            if (line.startsWith("Connecting")) { emit(stage, "Connecting to device...", pctStart); return; }
            if (line.startsWith("Uploading stub")) { emit(stage, "Uploading flash stub...", pctStart + 2); return; }
            if (line.startsWith("Configuring flash")) { emit(stage, "Configuring flash...", pctStart + 5); return; }
            if (line.startsWith("Leaving") || line.startsWith("Hard resetting")) {
                emit(stage, "Resetting device...", pctEnd - 1);
                return;
            }

            // Binary size info
            if (line.includes("binary size") && line.includes("free")) {
                emit("info", line);
                return;
            }

            // Errors — always show
            if (line.includes("error:") || line.includes("FAILED:") || line.includes("Error")) {
                emit("error", line);
                return;
            }

            // Warnings
            if (line.includes("warning:") && line.includes(".c:")) {
                emit("warn", line);
                return;
            }

            // Success markers
            if (line.startsWith("Successfully created")) { emit("info", line); return; }
        }

        // Read both stdout and stderr line by line
        let stdoutBuf = "";
        child.stdout.on("data", (data) => {
            stdoutBuf += data.toString();
            const lines = stdoutBuf.split(/[\r\n]/);
            stdoutBuf = lines.pop(); // keep incomplete line
            lines.forEach(processLine);
        });

        let stderrBuf = "";
        child.stderr.on("data", (data) => {
            stderrBuf += data.toString();
            const lines = stderrBuf.split(/[\r\n]/);
            stderrBuf = lines.pop();
            lines.forEach(processLine);
        });

        child.on("close", (code) => {
            // Flush remaining
            if (stdoutBuf.trim()) processLine(stdoutBuf);
            if (stderrBuf.trim()) processLine(stderrBuf);
            resolve(code === 0);
        });

        child.on("error", (err) => {
            emit("error", "Failed to start: " + err.message);
            resolve(false);
        });
    });
}

function isBuildNoise(line) {
    if (line.startsWith("--")) return true;
    if (line.startsWith("PICO_")) return true;
    if (line.startsWith("Using board")) return true;
    if (line.startsWith("Build type")) return true;
    if (line.startsWith("Using precompiled")) return true;
    if (line.startsWith("PICOTOOL_NO_LIBUSB")) return true;
    if (line.startsWith("Target board")) return true;
    if (line.startsWith("Pico Platform")) return true;
    if (line.startsWith("TinyUSB")) return true;
    if (line.startsWith("BTstack")) return true;
    if (line.startsWith("cyw43")) return true;
    if (line.startsWith("Executing action:")) return true;
    if (line.startsWith("Running ninja")) return true;
    if (line.startsWith("Executing \"ninja")) return true;
    if (line.startsWith("Executing \"cmake")) return true;
    if (line.startsWith("Project build complete")) return true;
    if (line.startsWith("Configuring toolchain")) return true;
    if (line.startsWith("Compressed ")) return true;
    if (line.startsWith("Hash of data")) return true;
    if (line.startsWith("Checking \"python")) return true;
    if (line.startsWith("[1/1] cd")) return true;
    if (line.includes("available at /")) return true;
    if (line.includes("Findpicotool")) return true;
    return false;
}

// ============================================================
// RP2040
// ============================================================

async function buildRP2040(projectPath, emit) {
    const fw = frameworkDir("rp2040");
    if (!fs.existsSync(fw)) { emit("error", "RP2040 framework not found"); return false; }

    // Copy main.c
    const src = path.join(projectPath, "build", "main.c");
    const dst = path.join(fw, "main", "main.c");
    if (!fs.existsSync(src)) { emit("error", "No main.c — compile first"); return false; }
    fs.copyFileSync(src, dst);

    const buildDir = path.join(fw, "build");
    fs.mkdirSync(buildDir, { recursive: true });
    const sdk = toolchain.picoSdkPath();
    const env = { PICO_SDK_PATH: sdk };

    // CMake configure
    if (!fs.existsSync(path.join(buildDir, "Makefile")) &&
        !fs.existsSync(path.join(buildDir, "build.ninja"))) {
        emit("build", "Configuring CMake...", 28);
        const ok = await streamCommand(
            `cmake -S "${fw}" -B "${buildDir}" -DPICO_SDK_PATH="${sdk}"`,
            "build", emit, env
        );
        if (!ok) { emit("error", "CMake configure failed"); return false; }
    }

    // Build
    emit("build", "Building firmware...", 30);
    const ok = await streamCommand(
        `cmake --build "${buildDir}" --parallel`,
        "build", emit, env
    );

    const uf2 = path.join(buildDir, "volt-rp2040.uf2");
    if (!ok && !fs.existsSync(uf2)) { emit("error", "Build failed"); return false; }

    if (fs.existsSync(uf2)) {
        const size = (fs.statSync(uf2).size / 1024).toFixed(0);
        emit("build", `Build complete — ${size}KB firmware`, 60);
    }
    return true;
}

async function flashRP2040(projectPath, port, emit) {
    const fw = frameworkDir("rp2040");
    const uf2 = path.join(fw, "build", "volt-rp2040.uf2");
    if (!fs.existsSync(uf2)) { emit("error", "No .uf2 file"); return false; }

    if (hasCommand("picotool")) {
        emit("flash", "Flashing with picotool...", 65);
        let ok = await streamCommand(`picotool load "${uf2}" -f`, "flash", emit);
        if (!ok) {
            emit("flash", "Retrying with sudo...", 68);
            ok = await streamCommand(`sudo picotool load "${uf2}" -f`, "flash", emit);
        }
        if (ok) {
            emit("flash", "Rebooting device...", 93);
            spawnSync("picotool", ["reboot"]);
            return true;
        }
    }

    // Fallback: BOOTSEL mount
    const mount = findPicoMount();
    if (mount) {
        emit("flash", "Copying .uf2 to Pico...", 80);
        try {
            fs.copyFileSync(uf2, path.join(mount, "volt-rp2040.uf2"));
            emit("flash", "Firmware copied — Pico rebooting", 95);
            return true;
        } catch (e) {
            emit("error", "Copy failed: " + e.message);
            return false;
        }
    }

    emit("error", "Cannot flash: hold BOOTSEL, plug in, then Run again");
    return false;
}

function findPicoMount() {
    for (const base of ["/media", "/mnt", "/run/media"]) {
        if (!fs.existsSync(base)) continue;
        try {
            for (const d of fs.readdirSync(base)) {
                const p = path.join(base, d);
                if (!fs.statSync(p).isDirectory()) continue;
                try {
                    for (const sub of fs.readdirSync(p)) {
                        if (sub.includes("RPI-RP2")) return path.join(p, sub);
                    }
                } catch {}
                if (d.includes("RPI-RP2")) return p;
            }
        } catch {}
    }
    return null;
}

// ============================================================
// ESP32
// ============================================================

async function buildESP32(projectPath, chip, emit) {
    const fw = frameworkDir("esp32");
    if (!fs.existsSync(fw)) { emit("error", "ESP32 framework not found"); return false; }

    const src = path.join(projectPath, "build", "main.c");
    const dst = path.join(fw, "main", "main.c");
    if (!fs.existsSync(src)) { emit("error", "No main.c — compile first"); return false; }
    fs.copyFileSync(src, dst);

    const idf = toolchain.espIdfPath(chip);
    emit("build", "Building firmware...", 30);
    const ok = await streamCommand(
        `source "${idf}/export.sh" >/dev/null 2>&1 && cd "${fw}" && idf.py build`,
        "build", emit
    );
    if (!ok) { emit("error", "Build failed"); return false; }

    emit("build", "Build complete", 60);
    return true;
}

async function flashESP32(projectPath, port, chip, emit) {
    const fw = frameworkDir("esp32");
    const idf = toolchain.espIdfPath(chip);

    emit("flash", `Flashing to ${port}...`, 65);
    const ok = await streamCommand(
        `source "${idf}/export.sh" >/dev/null 2>&1 && cd "${fw}" && idf.py -p "${port}" flash`,
        "flash", emit
    );
    if (!ok) { emit("error", "Flash failed"); return false; }

    emit("flash", "Flash complete", 95);
    return true;
}

// ============================================================
// Helpers
// ============================================================

function hasCommand(name) {
    try { execSync(`which ${name}`, { stdio: "ignore" }); return true; }
    catch { return false; }
}

function waitForPort(prefix, timeoutMs) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
        try {
            const found = fs.readdirSync("/dev").find(e => e.startsWith(prefix));
            if (found) return "/dev/" + found;
        } catch {}
        spawnSync("sleep", ["0.5"]);
    }
    return null;
}

function readChipFromToml(projectPath) {
    const toml = path.join(projectPath, "volt.toml");
    if (!fs.existsSync(toml)) return "esp32";
    const m = fs.readFileSync(toml, "utf-8").match(/chip\s*=\s*"([^"]+)"/);
    return m ? m[1] : "esp32";
}

module.exports = {
    buildRP2040, flashRP2040,
    buildESP32, flashESP32,
    frameworkDir, readChipFromToml, waitForPort,
};
