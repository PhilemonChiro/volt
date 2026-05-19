// Serial service — device scanning, serial monitor
const api = window.volt;

export async function scanDevices() {
    return api.scanDevices();
}

export async function startMonitor(port, baud) {
    return api.startMonitor(port, baud);
}

export async function stopMonitor() {
    return api.stopMonitor();
}

export async function isMonitoring() {
    return api.isMonitoring();
}

export function onSerialData(callback) {
    api.onSerial(callback);
}
