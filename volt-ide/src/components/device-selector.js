// Device selector — scans USB, shows dropdown, auto-detects boards

const api = window.volt;

let devices = [];
let selectedIndex = 0;
let scanInterval = null;
let onDeviceChange = null;

function esc(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// Produce a human-readable chip label that includes ground-truth state.
// Detection alone (from USB VID:PID) is unreliable for ESP32 — the CH340 /
// CP2102 bridge enumerates whether or not the chip behind it is alive.
// The probe state distinguishes:
//   verified  → esptool got a chip response (chip is in download mode)
//   silent    → chip didn't reply (could be running firmware OR dead)
//   running   → port held by serial monitor (we can't probe; assume alive)
function labelFor(dev) {
    if (dev.state === "bootsel") return `${dev.chip} (BOOTSEL)`;
    if (dev.probe === "verified") return `${dev.chip} ✓`;
    if (dev.probe === "silent")   return `${dev.chip} (no response)`;
    if (dev.probe === "running")  return dev.chip;  // monitor active — don't add noise
    return dev.chip;
}

export function init(onChange) {
    onDeviceChange = onChange;

    // Dropdown toggle
    const selector = document.getElementById("deviceSelector");
    const dropdown = document.getElementById("deviceDropdown");

    if (selector) {
        selector.onclick = (e) => {
            e.stopPropagation();
            const isOpen = dropdown.classList.toggle("open");
            if (isOpen) scan(); // Refresh on open
        };
    }

    // Close on outside click
    document.addEventListener("click", (e) => {
        if (!e.target.closest(".device-selector-wrap")) {
            if (dropdown) dropdown.classList.remove("open");
        }
    });

    // Initial scan + periodic scan every 3 seconds
    scan();
    scanInterval = setInterval(scan, 3000);
}

export async function scan() {
    try {
        devices = await api.scanDevices();
    } catch (_) {
        devices = [];
    }
    updateUI();
}

export function getSelected() {
    if (devices.length === 0) return null;
    if (selectedIndex >= devices.length) selectedIndex = 0;
    return devices[selectedIndex];
}

export function getDevices() {
    return devices;
}

function updateUI() {
    const label = document.getElementById("deviceLabel");
    const dot = document.getElementById("deviceDot");
    const dropdownList = document.getElementById("dropdownList");
    const dropdownEmpty = document.getElementById("dropdownEmpty");

    if (!label) return;

    if (devices.length === 0) {
        label.textContent = "No device";
        if (dot) dot.className = "device-dot";
        if (dropdownEmpty) dropdownEmpty.style.display = "block";
        if (dropdownList) dropdownList.innerHTML = "";
    } else {
        if (selectedIndex >= devices.length) selectedIndex = 0;
        const d = devices[selectedIndex];

        const labelText = labelFor(d);
        label.textContent = labelText;
        if (dot) dot.className = "device-dot connected";
        if (dropdownEmpty) dropdownEmpty.style.display = "none";

        if (dropdownList) {
            dropdownList.innerHTML = devices.map((dev, i) => {
                const chipLabel = labelFor(dev);
                return `
                <div class="dropdown-item ${i === selectedIndex ? "selected" : ""}" data-index="${i}">
                    <span class="device-dot ${dev.chip !== "Unknown" ? "connected" : ""}"></span>
                    <div>
                        <div class="dropdown-chip">${esc(chipLabel)}</div>
                        <div class="dropdown-desc">${esc(dev.desc)}</div>
                    </div>
                    <span class="dropdown-port">${esc(dev.port)}</span>
                </div>`;
            }).join("");

            dropdownList.querySelectorAll(".dropdown-item").forEach(item => {
                item.onclick = () => {
                    selectedIndex = parseInt(item.dataset.index);
                    updateUI();
                    document.getElementById("deviceDropdown").classList.remove("open");
                    if (onDeviceChange) onDeviceChange(devices[selectedIndex]);
                };
            });
        }
    }

    // Update status bar
    const statusChip = document.getElementById("statusChip");
    if (statusChip) {
        if (devices.length > 0) {
            const d = devices[selectedIndex];
            const chipLabel = labelFor(d);
            statusChip.innerHTML = `<span class="status-dot connected"></span> ${esc(chipLabel)} <span class="status-dim">${esc(d.port)}</span>`;
        } else {
            statusChip.innerHTML = '<span class="status-dot"></span> No device';
        }
    }

    if (onDeviceChange && devices.length > 0) {
        onDeviceChange(devices[selectedIndex]);
    }
}

export function destroy() {
    if (scanInterval) clearInterval(scanInterval);
}
