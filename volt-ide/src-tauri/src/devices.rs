use serde::Serialize;
use serialport;

#[derive(Debug, Serialize, Clone)]
pub struct Device {
    pub port: String,
    pub chip: String,
    pub desc: String,
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
                    // CH340/CP2102/FTDI — could be ESP32 or ESP8266
                    // Would need esptool to identify, mark as pending
                    "Espressif".to_string()
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
