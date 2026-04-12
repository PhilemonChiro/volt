mod devices;
mod serial;
mod runner;
mod projects;
mod checker;
mod toolchain;

use devices::Device;
use projects::{ProjectInfo, BrowseResult};
use checker::{DiagnosticItem, SymbolInfo};

#[tauri::command]
fn scan_devices() -> Vec<Device> {
    devices::scan_devices()
}

#[tauri::command]
fn start_monitor(app: tauri::AppHandle, port: String, baud: u32) {
    serial::start_monitor(app, port, baud);
}

#[tauri::command]
fn stop_monitor() {
    serial::stop_monitor();
}

#[tauri::command]
fn is_monitoring() -> bool {
    serial::is_monitoring()
}

#[tauri::command]
fn run_project(app: tauri::AppHandle, project_path: String, volt_file: String, port: String, chip: String) {
    runner::run_pipeline(app, project_path, volt_file, port, chip);
}

#[tauri::command]
fn read_file(path: String) -> Result<String, String> {
    projects::read_file(&path)
}

#[tauri::command]
fn save_file(path: String, content: String) -> Result<(), String> {
    let result = projects::save_file(&path, &content);
    // Sync volt.toml if saving a .volt file
    if path.ends_with(".volt") {
        if let Some(parent) = std::path::Path::new(&path).parent() {
            projects::sync_project_toml(&parent.to_string_lossy());
        }
    }
    result
}

#[tauri::command]
fn create_project(name: String, chip: String) -> Result<String, String> {
    projects::create_project(&name, &chip)
}

#[tauri::command]
fn browse_volt_file() -> Option<BrowseResult> {
    projects::browse_volt_file()
}

#[tauri::command]
fn list_projects() -> Vec<ProjectInfo> {
    projects::list_projects()
}

#[tauri::command]
fn check_code(source: String) -> Vec<DiagnosticItem> {
    checker::check_code(&source)
}

#[tauri::command]
fn find_symbols(source: String) -> Vec<SymbolInfo> {
    checker::find_symbols(&source)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            scan_devices,
            start_monitor,
            stop_monitor,
            is_monitoring,
            run_project,
            read_file,
            save_file,
            create_project,
            browse_volt_file,
            list_projects,
            check_code,
            find_symbols,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
