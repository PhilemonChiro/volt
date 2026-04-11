mod devices;
mod serial;
mod runner;
mod projects;

use devices::Device;
use projects::ProjectInfo;

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
fn run_project(app: tauri::AppHandle, project_path: String, port: String, chip: String) {
    runner::run_pipeline(app, project_path, port, chip);
}

#[tauri::command]
fn read_file(path: String) -> Result<String, String> {
    projects::read_file(&path)
}

#[tauri::command]
fn save_file(path: String, content: String) -> Result<(), String> {
    projects::save_file(&path, &content)
}

#[tauri::command]
fn create_project(name: String, chip: String) -> Result<String, String> {
    projects::create_project(&name, &chip)
}

#[tauri::command]
fn open_project_dialog() -> Option<String> {
    projects::open_project_dialog()
}

#[tauri::command]
fn list_projects() -> Vec<ProjectInfo> {
    projects::list_projects()
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
            open_project_dialog,
            list_projects,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
