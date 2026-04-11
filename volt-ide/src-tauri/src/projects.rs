use std::fs;
use std::path::PathBuf;

/// Read a file and return its contents
pub fn read_file(path: &str) -> Result<String, String> {
    fs::read_to_string(path).map_err(|e| format!("Cannot read {}: {}", path, e))
}

/// Save content to a file
pub fn save_file(path: &str, content: &str) -> Result<(), String> {
    // Ensure parent directory exists
    if let Some(parent) = std::path::Path::new(path).parent() {
        fs::create_dir_all(parent).ok();
    }
    fs::write(path, content).map_err(|e| format!("Cannot write {}: {}", path, e))
}

/// Create a new Volt project in ~/Volt/
pub fn create_project(name: &str, chip: &str) -> Result<String, String> {
    let projects_dir = dirs::home_dir()
        .ok_or("Cannot find home directory")?
        .join("Volt");

    fs::create_dir_all(&projects_dir).ok();

    let project_dir = projects_dir.join(name);
    if project_dir.exists() {
        return Err(format!("Project '{}' already exists", name));
    }

    fs::create_dir_all(&project_dir).map_err(|e| e.to_string())?;
    fs::create_dir_all(project_dir.join("build")).ok();

    // Default LED pin per chip
    let led_pin = match chip {
        "rp2040" | "pico" => "GP25",
        "stm32f103" | "stm32" | "bluepill" => "PC13",
        _ => "2",
    };

    // Write main.volt
    let source = format!(
        "chip {chip}\n\n\
         hardware {{\n\
         \    pin led: Output = {led}\n\
         }}\n\n\
         task blink() {{\n\
         \    every 500ms {{\n\
         \        led.toggle()\n\
         \    }}\n\
         }}\n\n\
         main {{\n\
         \    run(blink)\n\
         }}\n",
        chip = chip,
        led = led_pin,
    );
    fs::write(project_dir.join("main.volt"), &source).map_err(|e| e.to_string())?;

    // Write volt.toml
    let toml = format!(
        "[project]\nname = \"{}\"\nversion = \"0.1.0\"\nchip = \"{}\"\n",
        name, chip
    );
    fs::write(project_dir.join("volt.toml"), &toml).map_err(|e| e.to_string())?;

    // Write .gitignore
    fs::write(project_dir.join(".gitignore"), "build/\n.volt/\n").ok();

    Ok(project_dir.to_string_lossy().to_string())
}

/// Open a folder dialog and return the selected path
pub fn open_project_dialog() -> Option<String> {
    let projects_dir = dirs::home_dir()
        .map(|h| h.join("Volt"))
        .unwrap_or_default();

    // Use native dialog via rfd or fall back
    // For now return None — the frontend will use @tauri-apps/plugin-dialog
    None
}
