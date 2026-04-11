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
"chip {chip}

hardware {{
    pin led: Output = {led}
}}

task blink() {{
    every 500ms {{
        led.toggle()
    }}
}}

main {{
    run(blink)
}}
", chip = chip, led = led_pin);
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

/// List all Volt projects in ~/Volt/ (folders containing main.volt)
pub fn list_projects() -> Vec<ProjectInfo> {
    let projects_dir = dirs::home_dir()
        .map(|h| h.join("Volt"))
        .unwrap_or_default();

    let mut projects = Vec::new();

    if let Ok(entries) = fs::read_dir(&projects_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() && path.join("main.volt").exists() {
                let name = path.file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .to_string();

                // Read chip from volt.toml or main.volt
                let chip = read_project_chip(&path).unwrap_or_else(|| "unknown".to_string());

                // Get last modified time
                let modified = fs::metadata(path.join("main.volt"))
                    .and_then(|m| m.modified())
                    .ok()
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_secs())
                    .unwrap_or(0);

                projects.push(ProjectInfo {
                    name,
                    path: path.to_string_lossy().to_string(),
                    chip,
                    modified,
                });
            }
        }
    }

    // Sort by most recently modified first
    projects.sort_by(|a, b| b.modified.cmp(&a.modified));
    projects
}

fn read_project_chip(path: &std::path::Path) -> Option<String> {
    // Try volt.toml
    if let Ok(toml) = fs::read_to_string(path.join("volt.toml")) {
        for line in toml.lines() {
            let trimmed = line.trim();
            if trimmed.starts_with("chip") && trimmed.contains('=') {
                let val = trimmed.split('=').nth(1)?.trim().trim_matches('"').trim_matches('\'');
                if !val.is_empty() {
                    return Some(val.to_string());
                }
            }
        }
    }
    // Try main.volt
    if let Ok(src) = fs::read_to_string(path.join("main.volt")) {
        for line in src.lines() {
            let trimmed = line.trim();
            if trimmed.starts_with("chip ") {
                return Some(trimmed[5..].trim().to_string());
            }
        }
    }
    None
}

#[derive(serde::Serialize)]
pub struct ProjectInfo {
    pub name: String,
    pub path: String,
    pub chip: String,
    pub modified: u64,
}
