use std::io::{BufRead, BufReader};
use std::process::{Command, Stdio};
use tauri::{AppHandle, Emitter};

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
        // Stop serial monitor before flashing (releases the port)
        crate::serial::stop_monitor();
        std::thread::sleep(std::time::Duration::from_millis(300));

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

        // Read the actual chip from the compiled source (not from USB detection)
        let actual_chip = read_chip_from_source(&volt_file).unwrap_or(chip.clone());
        let chip_lower = actual_chip.to_lowercase();

        emit(&app, "build", &format!("Building for {}...", actual_chip.to_uppercase()), 30);

        let build_ok = if chip_lower.contains("esp") {
            run_esp_build(&app, &project_path, &chip_lower)
        } else if chip_lower.contains("rp2040") || chip_lower.contains("pico") {
            run_pico_build(&app, &project_path)
        } else if chip_lower.contains("stm32") {
            emit(&app, "error", "STM32 build not yet implemented", 0);
            false
        } else {
            emit(&app, "error", &format!("Unknown chip: {}. Supported: esp32, esp8266, rp2040", actual_chip), 0);
            false
        };

        if !build_ok { return; }

        emit(&app, "build", "Build complete", 60);

        // Stage 3: Flash
        emit(&app, "flash", &format!("Flashing to {} on {}...", actual_chip.to_uppercase(), port), 65);

        let flash_ok = if chip_lower.contains("esp") {
            run_esp_flash(&app, &project_path, &port, &chip_lower)
        } else if chip_lower.contains("rp2040") || chip_lower.contains("pico") {
            run_pico_flash(&app, &project_path, &port)
        } else {
            false
        };

        if !flash_ok { return; }

        emit(&app, "done", "Running on device", 100);

        // Auto-start serial monitor after successful flash
        std::thread::sleep(std::time::Duration::from_millis(500));
        let baud = if chip_lower.contains("8266") { 74880 } else { 115200 };
        crate::serial::start_monitor(app.clone(), port, baud);
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
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            emit(app, "error", &format!("Failed to start: {}", e), 0);
            return false;
        }
    };

    // Stream stdout — filter noisy SDK output
    if let Some(stdout) = child.stdout.take() {
        let reader = BufReader::new(stdout);
        for line in reader.lines().flatten() {
            let trimmed = line.trim();
            // Skip noisy/useless lines
            if trimmed.is_empty() { continue; }
            if trimmed.starts_with("Checking \"python") { continue; }
            if trimmed.starts_with("Python ") { continue; }
            if trimmed.starts_with("\"python") { continue; }
            if trimmed.starts_with("Done! You can now") { continue; }
            if trimmed.starts_with("Go to the project") { continue; }
            if trimmed.starts_with("  idf.py") { continue; }
            if trimmed.starts_with("  make") { continue; }
            if trimmed.starts_with("-- Component paths:") { continue; }
            if trimmed.starts_with("-- Components:") { continue; }
            if trimmed.starts_with("-- Adding linker") { continue; }
            if trimmed.starts_with("or from the") { continue; }
            if trimmed.starts_with("  python -m esptool") { continue; }
            if trimmed == "or" { continue; }
            let _ = app.emit("run:output", &line);
        }
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

fn get_framework_dir() -> std::path::PathBuf {
    let home = dirs::home_dir().unwrap();
    // Try dev location first, then installed SDK
    let dev = home.join("dev/volt/framework");
    if dev.exists() { return dev; }
    let sdk = home.join(".volt/sdk/framework");
    if sdk.exists() { return sdk; }
    dev // fallback
}

fn run_esp_build(app: &AppHandle, project_path: &str, chip: &str) -> bool {
    let idf_path = if chip.contains("8266") {
        dirs::home_dir().unwrap().join(".volt/toolchains/esp8266-rtos-sdk")
    } else {
        let home = dirs::home_dir().unwrap();
        if home.join("esp/esp-idf").exists() {
            home.join("esp/esp-idf")
        } else {
            home.join(".volt/toolchains/esp-idf")
        }
    };

    let fw_dir = get_framework_dir();
    if !fw_dir.exists() {
        emit(app, "error", &format!("Framework not found at {}", fw_dir.display()), 0);
        return false;
    }

    // Copy generated main.c into the framework build location
    let src = format!("{}/build/main.c", project_path);
    let dst = fw_dir.join("main/main.c");
    if let Err(e) = std::fs::copy(&src, &dst) {
        emit(app, "error", &format!("Cannot copy main.c to framework: {}", e), 0);
        return false;
    }

    let mut cmd = Command::new("bash");
    cmd.arg("-c")
       .arg(format!("source {}/export.sh 2>/dev/null && idf.py build", idf_path.display()))
       .current_dir(&fw_dir);

    stream_command(app, cmd, "Build")
}

fn run_esp_flash(app: &AppHandle, _project_path: &str, port: &str, chip: &str) -> bool {
    let idf_path = if chip.contains("8266") {
        dirs::home_dir().unwrap().join(".volt/toolchains/esp8266-rtos-sdk")
    } else {
        let home = dirs::home_dir().unwrap();
        if home.join("esp/esp-idf").exists() {
            home.join("esp/esp-idf")
        } else {
            home.join(".volt/toolchains/esp-idf")
        }
    };

    let fw_dir = get_framework_dir();

    let mut cmd = Command::new("bash");
    cmd.arg("-c")
       .arg(format!("source {}/export.sh 2>/dev/null && idf.py -p {} flash", idf_path.display(), port))
       .current_dir(&fw_dir);

    stream_command(app, cmd, "Flash")
}

fn run_pico_build(app: &AppHandle, project_path: &str) -> bool {
    let sdk = dirs::home_dir().unwrap().join(".volt/toolchains/pico-sdk");

    let build_dir = format!("{}/build", project_path);
    std::fs::create_dir_all(&build_dir).ok();

    let mut cmd = Command::new("bash");
    cmd.arg("-c")
       .arg(format!("PICO_SDK_PATH={} cmake .. && make -j$(nproc)", sdk.display()))
       .current_dir(&build_dir);

    stream_command(app, cmd, "Build")
}

fn run_pico_flash(app: &AppHandle, project_path: &str, port: &str) -> bool {
    // Send reboot command then copy UF2
    // For now just emit that it needs BOOTSEL
    emit(app, "flash", "Flashing Pico...", 80);

    // Try to send reset command to enter BOOTSEL
    if let Ok(mut serial) = serialport::new(port, 115200)
        .timeout(std::time::Duration::from_millis(500))
        .open()
    {
        use std::io::Write;
        let _ = serial.write(&[0x07]); // BEL = reboot to BOOTSEL
        drop(serial);
        std::thread::sleep(std::time::Duration::from_secs(2));
    }

    // Look for UF2 mount
    let home = dirs::home_dir().unwrap();
    let user = std::env::var("USER").unwrap_or_default();
    let mount = format!("/media/{}/RPI-RP2", user);

    if std::path::Path::new(&mount).exists() {
        let uf2 = format!("{}/build/*.uf2", project_path);
        let result = Command::new("bash")
            .arg("-c")
            .arg(format!("cp {}  {}/", uf2, mount))
            .output();

        match result {
            Ok(o) if o.status.success() => {
                emit(app, "flash", "UF2 copied — Pico rebooting", 95);
                std::thread::sleep(std::time::Duration::from_secs(2));
                true
            }
            _ => {
                emit(app, "error", "Failed to copy UF2 to Pico", 0);
                false
            }
        }
    } else {
        emit(app, "error", "Pico not in BOOTSEL mode — hold BOOTSEL and replug", 0);
        false
    }
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

fn get_volt_src_path() -> String {
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
