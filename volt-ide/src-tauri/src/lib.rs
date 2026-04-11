mod devices;

use devices::Device;

#[tauri::command]
fn scan_devices() -> Vec<Device> {
    devices::scan_devices()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![scan_devices])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
