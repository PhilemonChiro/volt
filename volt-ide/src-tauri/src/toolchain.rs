use std::path::PathBuf;
use std::process::Command;
use tauri::{AppHandle, Emitter};

#[derive(Clone, serde::Serialize)]
struct ToolchainProgress {
    stage: String,
    message: String,
    percent: u32,
}

fn emit(app: &AppHandle, msg: &str, pct: u32) {
    let _ = app.emit("run:progress", ToolchainProgress {
        stage: "setup".to_string(),
        message: msg.to_string(),
        percent: pct,
    });
}

fn toolchains_dir() -> PathBuf {
    dirs::home_dir().unwrap().join(".volt/toolchains")
}

// ================================================================
// RP2040 — Pico SDK + ARM GCC
// ================================================================

pub fn pico_sdk_path() -> PathBuf {
    toolchains_dir().join("pico-sdk")
}

pub fn ensure_rp2040(app: &AppHandle) -> bool {
    // Check ARM GCC
    if !has_command("arm-none-eabi-gcc") {
        emit(app, "Installing ARM GCC toolchain...", 10);
        if !install_arm_gcc(app) {
            let _ = app.emit("run:progress", ToolchainProgress {
                stage: "error".to_string(),
                message: "Failed to install ARM GCC. Install manually: sudo apt install gcc-arm-none-eabi".to_string(),
                percent: 0,
            });
            return false;
        }
    }

    // Check cmake
    if !has_command("cmake") {
        emit(app, "Installing cmake...", 15);
        if !install_package(app, "cmake") {
            let _ = app.emit("run:progress", ToolchainProgress {
                stage: "error".to_string(),
                message: "Failed to install cmake. Install manually: sudo apt install cmake".to_string(),
                percent: 0,
            });
            return false;
        }
    }

    // Check pico-sdk
    let sdk = pico_sdk_path();
    if !sdk.join("pico_sdk_init.cmake").exists() {
        emit(app, "Downloading Raspberry Pi Pico SDK...", 18);
        if !clone_pico_sdk(app) {
            let _ = app.emit("run:progress", ToolchainProgress {
                stage: "error".to_string(),
                message: "Failed to download Pico SDK. Check internet connection.".to_string(),
                percent: 0,
            });
            return false;
        }
        emit(app, "Pico SDK ready", 22);
    }

    // Check picotool (with USB support for direct flashing)
    if !has_picotool_usb() {
        emit(app, "Installing picotool (for direct flashing)...", 23);
        if !install_picotool(app) {
            // Not fatal — can still flash via BOOTSEL mount
            let _ = app.emit("run:output", "picotool install failed — you can still flash via BOOTSEL mode.");
        } else {
            emit(app, "picotool ready", 25);
        }
    }

    true
}

/// Check if picotool is installed WITH USB support (can actually flash)
fn has_picotool_usb() -> bool {
    if !has_command("picotool") { return false; }
    // Run `picotool info` — if it says "no USB" or errors, USB support is missing
    let output = Command::new("picotool").arg("version").output();
    match output {
        Ok(o) => {
            let stdout = String::from_utf8_lossy(&o.stdout);
            // If compiled without USB, it says so
            !stdout.contains("without USB")
        }
        Err(_) => false,
    }
}

fn install_picotool(app: &AppHandle) -> bool {
    // Need libusb for USB flashing support
    let _ = app.emit("run:output", "Installing libusb-dev for USB support...");
    let _ = Command::new("bash").arg("-c")
        .arg("sudo apt-get install -y libusb-1.0-0-dev 2>&1")
        .output();

    let picotool_dir = toolchains_dir().join("picotool-build");
    std::fs::create_dir_all(&picotool_dir).ok();

    // Clone picotool source
    let src_dir = picotool_dir.join("src");
    if !src_dir.join("CMakeLists.txt").exists() {
        let _ = app.emit("run:output", "Downloading picotool source...");
        let clone = Command::new("git")
            .arg("clone").arg("--depth=1")
            .arg("https://github.com/raspberrypi/picotool.git")
            .arg(&src_dir)
            .output();
        if !clone.map(|o| o.status.success()).unwrap_or(false) {
            return false;
        }
    }

    // Build picotool with USB support
    let build_dir = picotool_dir.join("build");
    std::fs::create_dir_all(&build_dir).ok();

    let sdk = pico_sdk_path();

    emit(app, "Configuring picotool build...", 23);
    let cmake = Command::new("cmake")
        .arg("-S").arg(&src_dir)
        .arg("-B").arg(&build_dir)
        .arg(format!("-DPICO_SDK_PATH={}", sdk.display()))
        .arg("-DCMAKE_BUILD_TYPE=Release")
        .output();

    if !cmake.map(|o| o.status.success()).unwrap_or(false) {
        let _ = app.emit("run:output", "picotool cmake configure failed.");
        return false;
    }

    emit(app, "Building picotool (this takes ~30s)...", 24);
    let build = Command::new("cmake")
        .arg("--build").arg(&build_dir)
        .arg("--parallel")
        .output();

    if !build.map(|o| o.status.success()).unwrap_or(false) {
        let _ = app.emit("run:output", "picotool build failed.");
        return false;
    }

    // Install to /usr/local/bin
    let install = Command::new("bash").arg("-c")
        .arg(format!("sudo cp {}/picotool /usr/local/bin/picotool 2>&1", build_dir.display()))
        .output();

    if !install.map(|o| o.status.success()).unwrap_or(false) {
        // Try without sudo — put in ~/.local/bin
        let local_bin = dirs::home_dir().unwrap().join(".local/bin");
        std::fs::create_dir_all(&local_bin).ok();
        let _ = std::fs::copy(
            build_dir.join("picotool"),
            local_bin.join("picotool"),
        );
    }

    let _ = app.emit("run:output", "picotool installed with USB support.");

    // Set up udev rules so picotool can access USB without sudo
    setup_rp2040_udev(app);

    true
}

fn setup_rp2040_udev(app: &AppHandle) {
    let rules_path = std::path::Path::new("/etc/udev/rules.d/99-pico.rules");
    if rules_path.exists() { return; }

    let _ = app.emit("run:output", "Setting up USB permissions for Pico...");

    // Write to temp file first, then sudo cp
    let tmp = std::env::temp_dir().join("99-pico.rules");
    let rules = "# Raspberry Pi Pico — allow access without sudo\n\
        SUBSYSTEM==\"usb\", ATTRS{idVendor}==\"2e8a\", TAG+=\"uaccess\"\n\
        SUBSYSTEM==\"tty\", ATTRS{idVendor}==\"2e8a\", MODE=\"0666\"\n";

    if std::fs::write(&tmp, rules).is_ok() {
        let result = Command::new("bash").arg("-c")
            .arg(format!(
                "sudo cp {} /etc/udev/rules.d/99-pico.rules && sudo udevadm control --reload-rules && sudo udevadm trigger",
                tmp.display()))
            .output();

        match result {
            Ok(o) if o.status.success() => {
                let _ = app.emit("run:output", "USB permissions configured. Unplug and replug Pico to apply.");
            }
            _ => {
                let _ = app.emit("run:output", "Could not set udev rules. Serial may need sudo. Run: sudo usermod -a -G dialout $USER");
            }
        }
    }
}

fn has_command(name: &str) -> bool {
    Command::new("which")
        .arg(name)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

fn install_arm_gcc(app: &AppHandle) -> bool {
    // Try apt first (Debian/Ubuntu)
    let output = Command::new("bash")
        .arg("-c")
        .arg("sudo apt-get install -y gcc-arm-none-eabi libnewlib-arm-none-eabi 2>&1")
        .output();

    match output {
        Ok(o) => {
            let msg = String::from_utf8_lossy(&o.stdout);
            let _ = app.emit("run:output", msg.to_string());
            o.status.success()
        }
        Err(_) => false,
    }
}

fn install_package(app: &AppHandle, name: &str) -> bool {
    let output = Command::new("bash")
        .arg("-c")
        .arg(format!("sudo apt-get install -y {} 2>&1", name))
        .output();

    match output {
        Ok(o) => {
            let msg = String::from_utf8_lossy(&o.stdout);
            let _ = app.emit("run:output", msg.to_string());
            o.status.success()
        }
        Err(_) => false,
    }
}

fn clone_pico_sdk(app: &AppHandle) -> bool {
    let dir = toolchains_dir();
    std::fs::create_dir_all(&dir).ok();

    let _ = app.emit("run:output", "Cloning pico-sdk (this may take a minute)...");

    let output = Command::new("git")
        .arg("clone")
        .arg("--depth=1")
        .arg("--recurse-submodules")
        .arg("--shallow-submodules")
        .arg("https://github.com/raspberrypi/pico-sdk.git")
        .arg(pico_sdk_path())
        .output();

    match output {
        Ok(o) => {
            if !o.status.success() {
                let stderr = String::from_utf8_lossy(&o.stderr);
                let _ = app.emit("run:output", stderr.to_string());
            }
            o.status.success()
        }
        Err(e) => {
            let _ = app.emit("run:output", format!("git clone failed: {}", e));
            false
        }
    }
}

// ================================================================
// ESP-IDF (ESP32 / ESP8266)
// ================================================================

pub fn ensure_esp_idf(app: &AppHandle, chip: &str) -> bool {
    let idf = esp_idf_path(chip);
    if idf.join("export.sh").exists() {
        return true;
    }

    emit(app, &format!("ESP-IDF not found for {}. Setting up...", chip.to_uppercase()), 10);

    if chip.contains("8266") {
        // ESP8266 RTOS SDK
        let _ = app.emit("run:output", "Downloading ESP8266 RTOS SDK...");
        let output = Command::new("git")
            .arg("clone")
            .arg("--depth=1")
            .arg("--recurse-submodules")
            .arg("--shallow-submodules")
            .arg("https://github.com/espressif/ESP8266_RTOS_SDK.git")
            .arg(&idf)
            .output();

        if !output.map(|o| o.status.success()).unwrap_or(false) {
            let _ = app.emit("run:progress", ToolchainProgress {
                stage: "error".to_string(),
                message: "Failed to download ESP8266 SDK.".to_string(),
                percent: 0,
            });
            return false;
        }

        // Install python deps
        emit(app, "Installing ESP8266 SDK dependencies...", 20);
        let _ = Command::new("bash")
            .arg("-c")
            .arg(format!("cd {} && ./install.sh 2>&1", idf.display()))
            .output();

    } else {
        // ESP-IDF for ESP32
        let _ = app.emit("run:output", "Downloading ESP-IDF (this may take several minutes)...");
        let output = Command::new("git")
            .arg("clone")
            .arg("--depth=1")
            .arg("-b")
            .arg("v5.4")
            .arg("--recurse-submodules")
            .arg("--shallow-submodules")
            .arg("https://github.com/espressif/esp-idf.git")
            .arg(&idf)
            .output();

        if !output.map(|o| o.status.success()).unwrap_or(false) {
            let _ = app.emit("run:progress", ToolchainProgress {
                stage: "error".to_string(),
                message: "Failed to download ESP-IDF.".to_string(),
                percent: 0,
            });
            return false;
        }

        // Run install.sh
        emit(app, "Installing ESP-IDF toolchain (this may take several minutes)...", 15);
        let install = Command::new("bash")
            .arg("-c")
            .arg(format!("cd {} && ./install.sh esp32 2>&1", idf.display()))
            .output();

        if !install.map(|o| o.status.success()).unwrap_or(false) {
            let _ = app.emit("run:progress", ToolchainProgress {
                stage: "error".to_string(),
                message: "ESP-IDF install.sh failed.".to_string(),
                percent: 0,
            });
            return false;
        }
    }

    emit(app, "Toolchain ready", 25);
    true
}

pub fn esp_idf_path(chip: &str) -> PathBuf {
    let home = dirs::home_dir().unwrap();
    if chip.contains("8266") {
        let custom = toolchains_dir().join("esp8266-rtos-sdk");
        if custom.exists() { return custom; }
        return custom;
    }
    // ESP32 — check common locations
    let dev = home.join("esp/esp-idf");
    if dev.exists() { return dev; }
    toolchains_dir().join("esp-idf")
}
