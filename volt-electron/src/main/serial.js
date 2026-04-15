let activePort = null;
let monitoring = false;

async function scanDevices() {
    try {
        const { SerialPort } = require("serialport");
        const ports = await SerialPort.list();
        return ports.map((p) => ({
            port: p.path,
            chip: detectChip(p),
            description: p.manufacturer || p.pnpId || "",
        }));
    } catch (e) {
        return [];
    }
}

function detectChip(portInfo) {
    const vid = (portInfo.vendorId || "").toLowerCase();
    const pid = (portInfo.productId || "").toLowerCase();
    const mfr = (portInfo.manufacturer || "").toLowerCase();

    if (vid === "303a") return "esp32";
    if (vid === "10c4" || vid === "1a86") return "esp32";
    if (vid === "2e8a") return "rp2040";
    if (mfr.includes("espressif")) return "esp32";
    if (mfr.includes("raspberry")) return "rp2040";
    if (mfr.includes("stm") || mfr.includes("st-link")) return "stm32";
    return "unknown";
}

function startMonitor(port, baud, onData) {
    stopMonitor();
    try {
        const { SerialPort } = require("serialport");
        const { ReadlineParser } = require("@serialport/parser-readline");

        activePort = new SerialPort({ path: port, baudRate: baud });
        const parser = activePort.pipe(new ReadlineParser());
        parser.on("data", (line) => onData(line));
        activePort.on("error", () => stopMonitor());
        activePort.on("close", () => { monitoring = false; });
        monitoring = true;
    } catch (e) {
        monitoring = false;
    }
}

function stopMonitor() {
    if (activePort && activePort.isOpen) {
        try { activePort.close(); } catch (_) {}
    }
    activePort = null;
    monitoring = false;
}

function isMonitoring() {
    return monitoring;
}

module.exports = { scanDevices, startMonitor, stopMonitor, isMonitoring };
