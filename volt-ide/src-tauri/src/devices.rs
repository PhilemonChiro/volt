use serde::Serialize;
use serialport;
use std::process::Command;

#[derive(Debug, Serialize, Clone)]
pub struct Device {
    pub port: String,
    pub chip: String,
    pub desc: String,
}

/// Try to identify Espressif chip via esptool (runs in ~3 seconds)
fn detect_espressif_chip(port: &str) -> Option<String> {
    let output = Command::new("python3")
        .args(["-m", "esptool", "--port", port, "chip-id"])
        .output()
        .ok()?;

    let text = String::from_utf8_lossy(&output.stdout).to_string()
        + &String::from_utf8_lossy(&output.stderr);

    for line in text.lines() {
        let lower = line.to_lowercase();
        if lower.contains("detecting chip type") || lower.contains("chip type:") {
            let cleaned = lower.replace("-", "").replace(" ", "");
            for chip in ["esp32s3", "esp32s2", "esp32c3", "esp32c6", "esp32h2", "esp32", "esp8266"] {
                if cleaned.contains(chip) {
                    return Some(chip.to_uppercase());
                }
            }
        }
    }
    None
}

/// Known USB vendor IDs for microcontrollers
fn chip_from_vid_pid(vid: u16, pid: u16) -> Option<&'static str> {
    match vid {
        0x2E8A => Some("RP2040"),       // Raspberry Pi
        0x0483 => Some("STM32"),        // STMicroelectronics
        0x303A => Some("ESP32-S3"),     // Espressif native USB
        _ => None,
    }
}

/// Scan for connected microcontroller serial ports
pub fn scan_devices() -> Vec<Device> {
    let mut devices = Vec::new();

    let ports = match serialport::available_ports() {
        Ok(p) => p,
        Err(_) => return devices,
    };

    for port in ports {
        match &port.port_type {
            serialport::SerialPortType::UsbPort(usb) => {
                let vid = usb.vid;
                let pid = usb.pid;
                let desc = usb.product.clone().unwrap_or_default();

                // Check known VIDs
                let chip = if let Some(c) = chip_from_vid_pid(vid, pid) {
                    c.to_string()
                } else if vid == 0x10C4 || vid == 0x1A86 || vid == 0x0403 {
                    // CH340/CP2102/FTDI — mark as ESP, don't probe every scan
                    // esptool probe is too slow and holds the port
                    "ESP".to_string()
                } else {
                    continue; // Skip non-MCU devices
                };

                devices.push(Device {
                    port: port.port_name.clone(),
                    chip,
                    desc,
                });
            }
            // Also check PCI/platform ports (ttyACM on Linux)
            serialport::SerialPortType::PciPort => {
                // Skip PCI serial ports (not MCUs)
            }
            serialport::SerialPortType::Unknown => {
                // On Linux, ttyACM ports may show as Unknown
                if port.port_name.contains("ttyACM") {
                    devices.push(Device {
                        port: port.port_name.clone(),
                        chip: "RP2040".to_string(), // ACM is usually Pico
                        desc: "USB CDC".to_string(),
                    });
                }
            }
            _ => {}
        }
    }

    devices
}
