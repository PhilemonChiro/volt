use std::io::{BufRead, BufReader};
use std::process::{Command, Stdio};
use tauri::{AppHandle, Emitter};

use crate::toolchain;

#[derive(Clone, serde::Serialize)]
struct RunProgress {
    stage: String,  // "compile", "build", "flash", "done", "error"
    message: String,
    percent: u32,
}

/// Run the full pipeline: compile .volt → build → flash
/// Streams progress to the frontend via events
pub fn run_pipeline(app: AppHandle, project_path: String, volt_file: String, port: String, chip: String) {
    std::thread::spawn(move || {
        let app = app.clone();

        // Stage 1: Compile .volt → C
        emit(&app, "compile", "Compiling Volt source...", 10);

        if !std::path::Path::new(&volt_file).exists() {
            emit(&app, "error", &format!("File not found: {}", volt_file), 0);
            return;
        }

        // Extract just the filename for the compiler
        let file_name = std::path::Path::new(&volt_file)
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();

        // Ensure build dir exists
        std::fs::create_dir_all(format!("{}/build", project_path)).ok();

        // Write compile script to build dir
        let volt_src = get_volt_src_path();
        let out_path = format!("{}/build/main.c", project_path);
        let script_path = format!("{}/build/_compile.py", project_path);

        let script = format!(
"import sys, os
# Add the parent of 'volt' package to path
sys.path.insert(0, '{}')
from volt.compiler.voltc import compile_volt

source = open('{}').read()
c, e = compile_volt(source, '{}')
errs = [x for x in e.errors if x.severity == 'error']
if errs:
    print('ERROR:' + errs[0].message)
elif c:
    os.makedirs(os.path.dirname('{}'), exist_ok=True)
    open('{}', 'w').write(c)
    print('OK')
else:
    print('ERROR:no output')
",
            volt_src.replace("\\", "/"),
            volt_file.replace("\\", "/"),
            file_name,
            out_path.replace("\\", "/"),
            out_path.replace("\\", "/"),
        );
        std::fs::write(&script_path, &script).ok();

        let compile_result = Command::new("python3")
            .arg(&script_path)
            .output();

        match compile_result {
            Ok(output) => {
                let stdout = String::from_utf8_lossy(&output.stdout);
                if stdout.contains("ERROR:") {
                    let msg = stdout.trim_start_matches("ERROR:").trim();
                    emit(&app, "error", &format!("Compile error: {}", msg), 0);
                    return;
                }
                if !stdout.contains("OK") {
                    let stderr = String::from_utf8_lossy(&output.stderr);
                    emit(&app, "error", &format!("Compile failed: {}", stderr.chars().take(200).collect::<String>()), 0);
                    return;
                }
            }
            Err(e) => {
                emit(&app, "error", &format!("Cannot run compiler: {}", e), 0);
                return;
            }
        }

        emit(&app, "compile", "Compiled successfully", 25);

        // Read the actual chip from the source file (not from USB detection)
        let actual_chip = read_chip_from_source(&volt_file).unwrap_or(chip.clone());
        let chip_lower = actual_chip.to_lowercase();

        emit(&app, "build", &format!("Building for {}...", actual_chip.to_uppercase()), 30);

        if chip_lower == "rp2040" || chip_lower == "pico" {
            // RP2040 build pipeline — auto-setup toolchain if needed
            if !toolchain::ensure_rp2040(&app) { return; }

            let build_ok = run_build_rp2040(&app, &project_path);
            if !build_ok { return; }

            emit(&app, "build", "Build complete", 60);

            emit(&app, "flash", &format!("Flashing to RP2040 on {}...", port), 65);
            let flash_ok = run_flash_rp2040(&app, &project_path, &port);
            if !flash_ok { return; }

        } else if chip_lower.contains("stm32") {
            emit(&app, "error", "STM32 build toolchain coming soon.", 0);
            return;

        } else {
            // ESP32 / ESP8266 pipeline — auto-setup toolchain if needed
            if !toolchain::ensure_esp_idf(&app, &chip_lower) { return; }

            let build_ok = run_build(&app, &project_path, &chip_lower);
            if !build_ok { return; }

            emit(&app, "build", "Build complete", 60);

            crate::serial::stop_monitor();
            std::thread::sleep(std::time::Duration::from_millis(500));
            crate::serial::release_port(&port);
            std::thread::sleep(std::time::Duration::from_millis(500));

            emit(&app, "flash", &format!("Flashing to {} on {}...", actual_chip.to_uppercase(), port), 65);
            let flash_ok = run_flash(&app, &project_path, &port, &chip_lower);
            if !flash_ok { return; }
        }

        emit(&app, "done", "Running on device", 100);

        // Auto-start serial monitor after successful flash
        let baud = if chip_lower.contains("8266") { 74880 } else { 115200 };

        // If port is "BOOTSEL", wait for the real serial port to appear
        let monitor_port = if port == "BOOTSEL" {
            emit(&app, "done", "Waiting for Pico to reboot...", 98);
            wait_for_serial_port("ttyACM", 8)
                .unwrap_or_else(|| port.clone())
        } else {
            std::thread::sleep(std::time::Duration::from_millis(500));
            port.clone()
        };

        if monitor_port != "BOOTSEL" {
            crate::serial::start_monitor(app.clone(), monitor_port, baud);
        }
    });
}

fn emit(app: &AppHandle, stage: &str, message: &str, percent: u32) {
    let _ = app.emit("run:progress", RunProgress {
        stage: stage.to_string(),
        message: message.to_string(),
        percent,
    });
}

fn stream_command(app: &AppHandle, mut cmd: Command, stage: &str) -> bool {
    // Merge stderr into stdout — esptool writes flash progress to stderr
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            emit(app, "error", &format!("Failed to start: {}", e), 0);
            return false;
        }
    };

    // Progress range per stage (within the 0-100 pipeline)
    let (pct_start, pct_end) = match stage {
        "build" => (30, 60),
        "flash" => (65, 95),
        _ => (0, 100),
    };

    // Read stdout with \r and \n splitting (esptool uses \r for progress)
    let (tx, rx) = std::sync::mpsc::channel::<String>();

    if let Some(stdout) = child.stdout.take() {
        let tx_out = tx.clone();
        std::thread::spawn(move || {
            read_lines_cr(stdout, tx_out);
        });
    }

    if let Some(stderr) = child.stderr.take() {
        let tx_err = tx.clone();
        std::thread::spawn(move || {
            read_lines_cr(stderr, tx_err);
        });
    }

    // Drop our tx so rx closes when both threads finish
    drop(tx);

    // Process all lines from both streams
    for line in rx {
        let trimmed = line.trim();
            if trimmed.is_empty() { continue; }

            // --- Skip build system noise ---
            if is_build_noise(trimmed) { continue; }

            // --- Parse ninja build steps: [N/M] description ---
            if let Some(steps) = parse_ninja_step(trimmed) {
                let pct = pct_start + (steps.0 * (pct_end - pct_start) / steps.1);
                let desc = steps.2;
                // Show meaningful descriptions only
                if desc.contains("Compiling") || desc.contains("compiling") {
                    emit(app, stage, &format!("Compiling ({}/{})", steps.0, steps.1), pct);
                } else if desc.contains("Linking") {
                    emit(app, stage, &format!("Linking ({}/{})", steps.0, steps.1), pct);
                } else if desc.contains("Generating") {
                    emit(app, stage, &format!("Generating ({}/{})", steps.0, steps.1), pct);
                } else if desc.contains("bootloader") {
                    emit(app, stage, &format!("Bootloader ({}/{})", steps.0, steps.1), pct);
                } else {
                    emit(app, stage, &format!("Building ({}/{})", steps.0, steps.1), pct);
                }
                continue;
            }

            // --- Parse esptool flash progress: Writing at 0x... (N %) ---
            if let Some(flash_pct) = parse_flash_progress(trimmed) {
                let pct = pct_start + (flash_pct * (pct_end - pct_start) / 100);
                emit(app, stage, &format!("Flashing... {}%", flash_pct), pct);
                continue;
            }

            // --- Parse esptool connection info ---
            if trimmed.starts_with("Connecting") {
                emit(app, stage, "Connecting to device...", pct_start);
                continue;
            }
            if trimmed.starts_with("Chip is ") {
                let _ = app.emit("run:output", trimmed);
                continue;
            }
            if trimmed.starts_with("Uploading stub") {
                emit(app, stage, "Uploading flash stub...", pct_start + 2);
                continue;
            }
            if trimmed.starts_with("Changing baud rate") {
                continue;
            }
            if trimmed.starts_with("Configuring flash") {
                emit(app, stage, "Configuring flash...", pct_start + 5);
                continue;
            }
            if trimmed.starts_with("Compressed ") {
                continue; // noise
            }
            if trimmed.starts_with("Wrote ") {
                let _ = app.emit("run:output", trimmed);
                continue;
            }
            if trimmed.starts_with("Hash of data verified") {
                continue;
            }
            if trimmed.starts_with("Leaving") || trimmed.starts_with("Hard resetting") {
                emit(app, stage, "Resetting device...", pct_end - 1);
                continue;
            }

            // --- Parse binary size info ---
            if trimmed.contains("binary size") && trimmed.contains("free") {
                // "volt-framework.bin binary size 0x2dab0 bytes ... 0xd2550 bytes (82%) free."
                if let Some(info) = parse_binary_size(trimmed) {
                    let _ = app.emit("run:output", &info);
                }
                continue;
            }

            // --- Parse compiler warnings ---
            if trimmed.contains("warning:") && trimmed.contains(".c:") {
                let _ = app.emit("run:output", trimmed);
                continue;
            }

            // --- Surface useful info, skip the rest ---
            if trimmed.starts_with("Successfully created") {
                let _ = app.emit("run:output", trimmed);
                continue;
            }
            if trimmed.starts_with("esptool.py") || trimmed.starts_with("Serial port")
               || trimmed.starts_with("Features:") || trimmed.starts_with("Crystal is")
               || trimmed.starts_with("MAC:") || trimmed.starts_with("Stub running")
               || trimmed.starts_with("Changed.") || trimmed.starts_with("Flash will be erased")
               || trimmed.starts_with("SHA digest") || trimmed.starts_with("Generated /")
               || trimmed.starts_with("Run") || trimmed.starts_with("cd /")
               || trimmed.starts_with("[") // remaining ninja steps not caught above
            {
                continue;
            }

            // Fallthrough: show anything else
            let _ = app.emit("run:output", trimmed);
        }

    let status = child.wait();
    match status {
        Ok(s) if s.success() => true,
        Ok(s) => {
            emit(app, "error", &format!("{} failed (exit code {})", stage, s.code().unwrap_or(-1)), 0);
            false
        }
        Err(e) => {
            emit(app, "error", &format!("{} error: {}", stage, e), 0);
            false
        }
    }
}

/// Read from a stream splitting on both \n and \r (esptool uses \r for flash progress)
/// Filter build system noise from ESP-IDF, CMake, Pico SDK
fn is_build_noise(line: &str) -> bool {
    // CMake configuration output
    if line.starts_with("--") { return true; }
    if line.starts_with("PICO_") { return true; }
    if line.starts_with("Defaulting") { return true; }
    if line.starts_with("Using board") { return true; }
    if line.starts_with("Pico Platform") { return true; }
    if line.starts_with("Build type") { return true; }
    if line.starts_with("Configuring toolchain") { return true; }
    if line.starts_with("Not searching") { return true; }
    if line.starts_with("Using precompiled") { return true; }
    if line.starts_with("PICOTOOL_NO_LIBUSB") { return true; }
    if line.starts_with("Call Stack") { return true; }
    if line.starts_with("CMake Warning") { return true; }
    if line.starts_with("CMake Error") { return false; } // show errors!
    if line.contains("available at /") { return true; }
    if line.contains("Findpicotool.cmake") { return true; }
    if line.contains("CMakeLists.txt:") && !line.contains("error") { return true; }
    if line.starts_with("Install the project") { return true; }
    if line.starts_with("Performing test step") { return true; }
    if line.starts_with("Completed '") { return true; }
    if line.starts_with("Downloading Picotool") { return true; }
    if line.starts_with("Using picotool from") { return true; }
    if line.contains("picotool v") { return true; }
    if line.contains("without USB support") { return true; }

    // ESP-IDF noise
    if line.starts_with("Checking \"python") { return true; }
    if line.starts_with("Python ") { return true; }
    if line.starts_with("\"python") { return true; }
    if line.starts_with("Done! You can now") { return true; }
    if line.starts_with("Go to the project") { return true; }
    if line.starts_with("  idf.py") { return true; }
    if line.starts_with("  make") { return true; }
    if line.starts_with("or from the") { return true; }
    if line.starts_with("  python -m esptool") { return true; }
    if line.starts_with("python -m esptool") { return true; }
    if line == "or" { return true; }
    if line == "Done" { return true; }
    if line.starts_with("idf.py ") { return true; }
    if line.starts_with("Executing action:") { return true; }
    if line.starts_with("Running ninja") { return true; }
    if line.starts_with("Executing \"ninja") { return true; }
    if line.starts_with("[1/1] cd ") { return true; }
    if line.starts_with("warning: config ") { return true; }
    if line.starts_with("Project build complete") { return true; }

    false
}

fn read_lines_cr(stream: impl std::io::Read, tx: std::sync::mpsc::Sender<String>) {
    use std::io::Read;
    let mut reader = BufReader::new(stream);
    let mut buf = Vec::with_capacity(512);
    let mut byte = [0u8; 1];

    loop {
        match reader.read(&mut byte) {
            Ok(0) => break, // EOF
            Ok(_) => {
                if byte[0] == b'\n' || byte[0] == b'\r' {
                    if !buf.is_empty() {
                        if let Ok(line) = String::from_utf8(buf.clone()) {
                            let _ = tx.send(line);
                        }
                        buf.clear();
                    }
                } else {
                    buf.push(byte[0]);
                }
            }
            Err(_) => break,
        }
    }
    // Flush remaining
    if !buf.is_empty() {
        if let Ok(line) = String::from_utf8(buf) {
            let _ = tx.send(line);
        }
    }
}

/// Parse ninja "[N/M] description" steps
fn parse_ninja_step(line: &str) -> Option<(u32, u32, String)> {
    if !line.starts_with('[') { return None; }
    let bracket_end = line.find(']')?;
    let inside = &line[1..bracket_end];
    let slash = inside.find('/')?;
    let n: u32 = inside[..slash].parse().ok()?;
    let m: u32 = inside[slash+1..].parse().ok()?;
    let desc = line[bracket_end+1..].trim().to_string();
    Some((n, m, desc))
}

/// Parse esptool "Writing at 0x... (N %)"
fn parse_flash_progress(line: &str) -> Option<u32> {
    if !line.starts_with("Writing at") { return None; }
    let paren = line.find('(')?;
    let pct_end = line.find('%')?;
    if pct_end <= paren + 1 { return None; }
    let pct_str = line[paren+1..pct_end].trim();
    pct_str.parse().ok()
}

/// Parse "name.bin binary size 0xNNNN bytes ... 0xNNNN bytes (NN%) free."
fn parse_binary_size(line: &str) -> Option<String> {
    // Extract just the filename and free percentage
    let name_end = line.find(".bin ")?;
    let name_start = line[..name_end].rfind(|c: char| c == '/' || c == ' ').map(|i| i + 1).unwrap_or(0);
    let name = &line[name_start..name_end + 4];

    if let Some(paren) = line.rfind('(') {
        if let Some(close) = line.rfind(')') {
            let free_info = &line[paren+1..close];
            return Some(format!("Binary: {} — {} free", name, free_info));
        }
    }
    None
}

fn get_framework_dir() -> std::path::PathBuf {
    let home = dirs::home_dir().unwrap();
    let dev = home.join("dev/volt/framework/esp32");
    if dev.exists() { return dev; }
    home.join(".volt/sdk/framework/esp32")
}

fn get_idf_path(chip: &str) -> std::path::PathBuf {
    toolchain::esp_idf_path(chip)
}

fn run_build(app: &AppHandle, project_path: &str, chip: &str) -> bool {
    let fw_dir = get_framework_dir();
    if !fw_dir.exists() {
        emit(app, "error", &format!("Framework not found at {}", fw_dir.display()), 0);
        return false;
    }

    // Copy generated main.c into framework
    let src = format!("{}/build/main.c", project_path);
    let dst = fw_dir.join("main/main.c");
    if let Err(e) = std::fs::copy(&src, &dst) {
        emit(app, "error", &format!("Cannot copy main.c: {}", e), 0);
        return false;
    }

    let idf = get_idf_path(chip);
    let mut cmd = Command::new("bash");
    cmd.arg("-c")
       .arg(format!("source {}/export.sh >/dev/null 2>&1 && idf.py build 2>&1", idf.display()))
       .current_dir(&fw_dir);

    stream_command(app, cmd, "build")
}

fn run_flash(app: &AppHandle, _project_path: &str, port: &str, chip: &str) -> bool {
    let fw_dir = get_framework_dir();
    let idf = get_idf_path(chip);

    let mut cmd = Command::new("bash");
    cmd.arg("-c")
       .arg(format!("source {}/export.sh >/dev/null 2>&1 && PYTHONUNBUFFERED=1 idf.py -p {} flash 2>&1", idf.display(), port))
       .env("PYTHONUNBUFFERED", "1")
       .current_dir(&fw_dir);

    stream_command(app, cmd, "flash")
}

/// Read the chip declaration from a .volt source file
fn read_chip_from_source(volt_file: &str) -> Option<String> {
    let source = std::fs::read_to_string(volt_file).ok()?;
    for line in source.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("chip ") {
            return Some(trimmed[5..].trim().to_string());
        }
    }
    None
}

// ================================================================
// RP2040 build + flash pipeline
// ================================================================

fn get_rp2040_framework_dir() -> std::path::PathBuf {
    let home = dirs::home_dir().unwrap();
    let dev = home.join("dev/volt/framework/rp2040");
    if dev.exists() { return dev; }
    home.join(".volt/sdk/framework/rp2040")
}

fn run_build_rp2040(app: &AppHandle, project_path: &str) -> bool {
    let fw_dir = get_rp2040_framework_dir();
    if !fw_dir.exists() {
        emit(app, "error", &format!("RP2040 framework not found at {}", fw_dir.display()), 0);
        return false;
    }

    // Copy generated main.c into framework (codegen produces chip-correct code)
    let src = format!("{}/build/main.c", project_path);
    let dst = fw_dir.join("main/main.c");
    if let Err(e) = std::fs::copy(&src, &dst) {
        emit(app, "error", &format!("Cannot copy main.c: {}", e), 0);
        return false;
    }

    // Create build directory
    let build_dir = fw_dir.join("build");
    std::fs::create_dir_all(&build_dir).ok();

    let sdk_path = toolchain::pico_sdk_path();

    // Run cmake if not configured yet
    if !build_dir.join("Makefile").exists() && !build_dir.join("build.ninja").exists() {
        emit(app, "build", "Configuring CMake for RP2040...", 32);
        let mut cmake = Command::new("cmake");
        cmake.arg("-S").arg(&fw_dir)
             .arg("-B").arg(&build_dir)
             .arg(format!("-DPICO_SDK_PATH={}", sdk_path.display()))
             .env("PICO_SDK_PATH", &sdk_path);

        if !stream_command(app, cmake, "build") {
            return false;
        }
    }

    // Build
    emit(app, "build", "Building RP2040 firmware...", 40);
    let mut make = Command::new("cmake");
    make.arg("--build").arg(&build_dir)
        .arg("--parallel")
        .env("PICO_SDK_PATH", &sdk_path);

    stream_command(app, make, "build")
}

fn run_flash_rp2040(app: &AppHandle, project_path: &str, port: &str) -> bool {
    let fw_dir = get_rp2040_framework_dir();
    let uf2 = fw_dir.join("build/volt-rp2040.uf2");

    if !uf2.exists() {
        emit(app, "error", "Build did not produce .uf2 file", 0);
        return false;
    }

    // Stop serial monitor before flashing
    crate::serial::stop_monitor();
    std::thread::sleep(std::time::Duration::from_millis(500));
    crate::serial::release_port(port);
    std::thread::sleep(std::time::Duration::from_millis(500));

    // Try picotool first (can flash without BOOTSEL mode)
    if has_picotool() {
        emit(app, "flash", "Flashing with picotool...", 70);

        let output = Command::new("picotool")
            .arg("load").arg(&uf2).arg("-f")
            .output();

        match output {
            Ok(o) if o.status.success() => {
                emit(app, "flash", "Rebooting device...", 95);
                let _ = Command::new("picotool").arg("reboot").output();
                return true;
            }
            Ok(o) => {
                let stderr = String::from_utf8_lossy(&o.stderr);
                let stdout = String::from_utf8_lossy(&o.stdout);
                let msg = format!("{}{}", stdout, stderr);

                if msg.contains("permission") || msg.contains("sudo") {
                    // USB permissions issue — try with sudo once
                    emit(app, "flash", "Retrying with elevated permissions...", 72);
                    let sudo_out = Command::new("sudo")
                        .arg("picotool").arg("load").arg(&uf2).arg("-f")
                        .output();

                    if sudo_out.map(|o| o.status.success()).unwrap_or(false) {
                        emit(app, "flash", "Rebooting device...", 95);
                        let _ = Command::new("sudo").arg("picotool").arg("reboot").output();
                        let _ = app.emit("run:output",
                            "Flashed with sudo. Unplug and replug the Pico to fix permissions for next time.");
                        return true;
                    }
                }
                // picotool failed — fall through to BOOTSEL method
            }
            Err(_) => {}
        }
    }

    // Fall back: copy .uf2 to mounted Pico drive (BOOTSEL mode)
    let mount_points = ["/media", "/mnt", "/run/media"];
    let mut pico_mount: Option<std::path::PathBuf> = None;

    for base in &mount_points {
        if let Ok(entries) = std::fs::read_dir(base) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    // Check subdirectories (e.g., /media/username/RPI-RP2)
                    if let Ok(sub) = std::fs::read_dir(&path) {
                        for s in sub.flatten() {
                            if s.file_name().to_string_lossy().contains("RPI-RP2") {
                                pico_mount = Some(s.path());
                            }
                        }
                    }
                    if path.file_name().unwrap_or_default().to_string_lossy().contains("RPI-RP2") {
                        pico_mount = Some(path);
                    }
                }
                if pico_mount.is_some() { break; }
            }
        }
        if pico_mount.is_some() { break; }
    }

    match pico_mount {
        Some(mount) => {
            emit(app, "flash", "Copying .uf2 to Pico...", 80);
            let dest = mount.join("volt-rp2040.uf2");
            match std::fs::copy(&uf2, &dest) {
                Ok(_) => {
                    emit(app, "flash", "Firmware copied. Pico will reboot.", 95);
                    std::thread::sleep(std::time::Duration::from_secs(3));
                    true
                }
                Err(e) => {
                    emit(app, "error", &format!("Cannot copy .uf2: {}", e), 0);
                    false
                }
            }
        }
        None => {
            emit(app, "error",
                 "Cannot flash: Pico not in BOOTSEL mode and picotool lacks permissions. Unplug Pico, hold BOOTSEL, plug back in, then Run again.",
                 0);
            false
        }
    }
}

/// Wait for a serial port matching a prefix to appear (e.g. "ttyACM")
fn wait_for_serial_port(prefix: &str, timeout_secs: u32) -> Option<String> {
    for _ in 0..(timeout_secs * 2) {
        std::thread::sleep(std::time::Duration::from_millis(500));
        if let Ok(entries) = std::fs::read_dir("/dev") {
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().to_string();
                if name.starts_with(prefix) {
                    return Some(format!("/dev/{}", name));
                }
            }
        }
    }
    None
}

fn has_picotool() -> bool {
    Command::new("which").arg("picotool")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

pub fn get_volt_src_path() -> String {
    // Try to find the volt source
    let home = dirs::home_dir().unwrap();
    let candidates = [
        home.join("dev/volt/src"),
        home.join(".volt/sdk/src"),
    ];
    for c in &candidates {
        if c.exists() {
            return c.to_string_lossy().to_string();
        }
    }
    "src".to_string()
}
