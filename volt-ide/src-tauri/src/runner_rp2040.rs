//! RP2040 build + flash pipeline
//!
//! Handles: cmake/pico-sdk build, picotool flash, BOOTSEL mount fallback

use std::process::Command;
use tauri::{AppHandle, Emitter};

use crate::runner::{emit, stream_command};
use crate::toolchain;

pub fn get_framework_dir() -> std::path::PathBuf {
    let home = dirs::home_dir().unwrap();
    let dev = home.join("dev/volt/framework-rp2040");
    if dev.exists() { return dev; }
    home.join(".volt/sdk/framework-rp2040")
}

pub fn build(app: &AppHandle, project_path: &str) -> bool {
    let fw_dir = get_framework_dir();
    if !fw_dir.exists() {
        emit(app, "error", &format!("RP2040 framework not found at {}", fw_dir.display()), 0);
        return false;
    }

    // Copy generated main.c into framework
    let src = format!("{}/build/main.c", project_path);
    let dst = fw_dir.join("main/main.c");
    if let Err(e) = std::fs::copy(&src, &dst) {
        emit(app, "error", &format!("Cannot copy main.c: {}", e), 0);
        return false;
    }

    let build_dir = fw_dir.join("build");
    std::fs::create_dir_all(&build_dir).ok();

    let sdk_path = toolchain::pico_sdk_path();

    // Configure cmake if needed
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

    emit(app, "build", "Building RP2040 firmware...", 40);
    let mut make = Command::new("cmake");
    make.arg("--build").arg(&build_dir)
        .arg("--parallel")
        .env("PICO_SDK_PATH", &sdk_path);

    stream_command(app, make, "build")
}

pub fn flash(app: &AppHandle, _project_path: &str, port: &str) -> bool {
    let fw_dir = get_framework_dir();
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

    // Try picotool first
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

pub fn wait_for_serial_port(prefix: &str, timeout_secs: u32) -> Option<String> {
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
