use std::io::Read;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

static MONITORING: AtomicBool = AtomicBool::new(false);

#[derive(Clone, serde::Serialize)]
struct SerialData {
    line: String,
}

pub fn start_monitor(app: AppHandle, port: String, baud: u32) {
    if MONITORING.load(Ordering::SeqCst) {
        return;
    }
    MONITORING.store(true, Ordering::SeqCst);

    std::thread::spawn(move || {
        let serial = serialport::new(&port, baud)
            .timeout(Duration::from_millis(500))
            .open();

        let mut serial = match serial {
            Ok(s) => s,
            Err(e) => {
                let _ = app.emit("serial:error", format!("Failed to open {}: {}", port, e));
                MONITORING.store(false, Ordering::SeqCst);
                return;
            }
        };

        let _ = app.emit("serial:connected", &port);

        let mut buf = [0u8; 1024];
        let mut line_buf = String::new();

        while MONITORING.load(Ordering::SeqCst) {
            match serial.read(&mut buf) {
                Ok(n) if n > 0 => {
                    let text = String::from_utf8_lossy(&buf[..n]);
                    line_buf.push_str(&text);

                    // Emit complete lines
                    while let Some(pos) = line_buf.find('\n') {
                        let line = line_buf[..pos].trim_end_matches('\r').to_string();
                        if !line.is_empty() {
                            let _ = app.emit("serial:data", SerialData { line });
                        }
                        line_buf = line_buf[pos + 1..].to_string();
                    }
                }
                Ok(_) => {} // timeout, no data
                Err(ref e) if e.kind() == std::io::ErrorKind::TimedOut => {}
                Err(_) => {
                    break; // port disconnected
                }
            }
        }

        let _ = app.emit("serial:disconnected", &port);
        MONITORING.store(false, Ordering::SeqCst);
    });
}

pub fn stop_monitor() {
    MONITORING.store(false, Ordering::SeqCst);
    // Wait for the thread to actually release the port
    for _ in 0..30 {
        std::thread::sleep(Duration::from_millis(100));
        if !MONITORING.load(Ordering::SeqCst) {
            // Double check — the thread sets this false after closing the port
            break;
        }
    }
}

/// Force-kill any process holding the serial port (lsof/fuser)
pub fn release_port(port: &str) {
    #[cfg(unix)]
    {
        let _ = std::process::Command::new("fuser")
            .args(["-k", port])
            .output();
    }
}

pub fn is_monitoring() -> bool {
    MONITORING.load(Ordering::SeqCst)
}
