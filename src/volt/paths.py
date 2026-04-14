"""
Volt Platform Paths — Cross-platform file location management.

Follows the convention of Cargo (~/.cargo), Bun (~/.bun), Deno (~/.deno).
Works on Linux, macOS, and Windows.

Layout:
    ~/.volt/                    Volt platform home
    ├── bin/                    CLI binary (added to PATH)
    ├── sdk/                    Framework C files (headers + sources)
    ├── toolchains/             ESP-IDF and cross-compilers
    ├── cache/                  Build cache, downloaded packages
    └── config.toml             Global config

    ~/projects/my-sensor/       User's project (anywhere)
    ├── main.volt               Source code
    ├── volt.toml               Project config
    ├── build/                  Generated C + binary
    └── .volt/                  Project-local cache
"""

import os
import sys
import shutil
import subprocess
from pathlib import Path


def _home() -> Path:
    """Get user home directory cross-platform."""
    return Path.home()


def volt_home() -> Path:
    """~/.volt — the Volt platform root directory.
    Override with VOLT_HOME environment variable."""
    custom = os.environ.get("VOLT_HOME")
    if custom:
        return Path(custom)
    return _home() / ".volt"


def volt_projects() -> Path:
    """~/Volt — default projects directory (like Arduino's ~/Arduino/).
    Override with VOLT_PROJECTS environment variable."""
    custom = os.environ.get("VOLT_PROJECTS")
    if custom:
        return Path(custom)
    return _home() / "Volt"


def volt_bin() -> Path:
    """~/.volt/bin — CLI binaries."""
    return volt_home() / "bin"


def volt_sdk() -> Path:
    """~/.volt/sdk — Framework C headers and sources."""
    return volt_home() / "sdk"


def volt_toolchains() -> Path:
    """~/.volt/toolchains — ESP-IDF and cross-compilers."""
    return volt_home() / "toolchains"


def volt_cache() -> Path:
    """~/.volt/cache — Build cache, downloads."""
    return volt_home() / "cache"


def volt_config() -> Path:
    """~/.volt/config.toml — Global configuration."""
    return volt_home() / "config.toml"


def idf_path() -> Path:
    """Path to ESP-IDF installation.
    Checks: VOLT_IDF_PATH env → IDF_PATH env → ~/.volt/toolchains/esp-idf → ~/esp/esp-idf"""
    for env_var in ["VOLT_IDF_PATH", "IDF_PATH"]:
        val = os.environ.get(env_var)
        if val and Path(val).exists():
            return Path(val)

    # Check Volt-managed location
    managed = volt_toolchains() / "esp-idf"
    if managed.exists():
        return managed

    # Fallback to common location
    common = _home() / "esp" / "esp-idf"
    if common.exists():
        return common

    return managed  # return expected path even if not installed yet


# ============================================================
# Project paths (relative to a .volt project)
# ============================================================

def project_build_dir(project_root: Path) -> Path:
    """<project>/build — generated C and compiled binary."""
    return project_root / "build"


def project_generated_dir(project_root: Path) -> Path:
    """<project>/build/generated — transpiled .c files."""
    return project_root / "build" / "generated"


def project_cache_dir(project_root: Path) -> Path:
    """<project>/.volt — project-local cache."""
    return project_root / ".volt"


def find_project_root(start: Path = None) -> Path | None:
    """Walk up from start directory to find a volt.toml or .volt file.
    Returns the directory containing it, or None."""
    if start is None:
        start = Path.cwd()

    current = start.resolve()
    while current != current.parent:
        if (current / "volt.toml").exists():
            return current
        if list(current.glob("*.volt")):
            return current
        current = current.parent

    return None


# ============================================================
# Platform initialization
# ============================================================

def ensure_volt_home():
    """Create the ~/.volt directory structure if it doesn't exist."""
    dirs = [
        volt_home(),
        volt_bin(),
        volt_sdk(),
        volt_sdk() / "include" / "volt",
        volt_sdk() / "src",
        volt_toolchains(),
        volt_cache(),
    ]
    for d in dirs:
        d.mkdir(parents=True, exist_ok=True)


def install_sdk(source_framework_dir: Path):
    """Copy framework headers and per-platform sources into ~/.volt/sdk/.
    Called during `pip install` or `volt setup`.

    Layout: framework/
              include/volt/   ← shared headers
              esp32/src/      ← ESP32 implementations
              rp2040/src/     ← RP2040 implementations
    """
    sdk = volt_sdk()

    # Copy shared headers
    include_src = source_framework_dir / "include" / "volt"
    include_dst = sdk / "include" / "volt"
    if include_src.exists():
        include_dst.mkdir(parents=True, exist_ok=True)
        for f in include_src.glob("*.h"):
            shutil.copy2(f, include_dst / f.name)

    # Copy per-platform sources and build files
    for platform in ["esp32", "rp2040"]:
        plat_dir = source_framework_dir / platform
        if not plat_dir.exists():
            continue

        # Sources
        src_dir = plat_dir / "src"
        dst_dir = sdk / platform / "src"
        if src_dir.exists():
            dst_dir.mkdir(parents=True, exist_ok=True)
            for f in src_dir.glob("*.c"):
                shutil.copy2(f, dst_dir / f.name)

        # Main entry point
        main_dir = plat_dir / "main"
        main_dst = sdk / platform / "main"
        if main_dir.exists():
            main_dst.mkdir(parents=True, exist_ok=True)
            for f in main_dir.iterdir():
                if f.is_file():
                    shutil.copy2(f, main_dst / f.name)

        # CMakeLists and config
        for cfg in ["CMakeLists.txt", "sdkconfig"]:
            cfg_file = plat_dir / cfg
            if cfg_file.exists():
                shutil.copy2(cfg_file, sdk / platform / cfg)

    # Copy main CMakeLists template
    main_cmake = source_framework_dir / "main" / "CMakeLists.txt"
    main_dst = sdk / "main"
    if main_cmake.exists():
        main_dst.mkdir(parents=True, exist_ok=True)
        shutil.copy2(main_cmake, main_dst / "CMakeLists.txt")


def get_platform() -> str:
    """Return current platform: 'linux', 'macos', or 'windows'."""
    if sys.platform.startswith("linux"):
        return "linux"
    elif sys.platform == "darwin":
        return "macos"
    elif sys.platform == "win32":
        return "windows"
    return "unknown"


# ============================================================
# Cross-platform shell execution
# ============================================================

def get_idf_env() -> dict:
    """Get environment variables with ESP-IDF tools in PATH.
    Works on Linux/macOS (source export.sh) and Windows (export.bat)."""
    env = os.environ.copy()
    idf = idf_path()

    if not idf.exists():
        return env

    platform = get_platform()

    if platform == "windows":
        # Windows: run export.bat and capture env
        export_bat = idf / "export.bat"
        if export_bat.exists():
            result = subprocess.run(
                ["cmd", "/c", f"{export_bat} && set"],
                capture_output=True, text=True,
            )
            if result.returncode == 0:
                for line in result.stdout.splitlines():
                    if "=" in line:
                        key, _, val = line.partition("=")
                        env[key] = val
    else:
        # Linux/macOS: source export.sh
        export_sh = idf / "export.sh"
        if export_sh.exists():
            result = subprocess.run(
                ["bash", "-c", f"source {export_sh} > /dev/null 2>&1 && env"],
                capture_output=True, text=True,
            )
            if result.returncode == 0:
                for line in result.stdout.splitlines():
                    if "=" in line:
                        key, _, val = line.partition("=")
                        env[key] = val

    # Always set IDF_PATH
    env["IDF_PATH"] = str(idf)
    return env


def run_idf_command(args: list, cwd: str = None, env: dict = None,
                     capture: bool = True) -> subprocess.CompletedProcess:
    """Run an idf.py command cross-platform.
    On Windows uses idf.py.exe or python idf.py; on Unix uses idf.py."""
    if env is None:
        env = get_idf_env()

    idf = idf_path()
    platform = get_platform()

    if platform == "windows":
        # Windows: python idf.py (no bash needed)
        idf_script = idf / "tools" / "idf.py"
        cmd = [sys.executable, str(idf_script)] + args
    else:
        cmd = ["idf.py"] + args

    return subprocess.run(
        cmd,
        cwd=cwd,
        env=env,
        capture_output=capture,
        text=True,
    )


# Known USB vendor IDs for microcontrollers
_MCU_VIDS = {
    0x10C4: "espressif",     # Silicon Labs CP2102 (ESP32)
    0x1A86: "espressif",     # WCH CH340 (ESP32/ESP8266)
    0x0403: "generic",       # FTDI (various boards)
    0x2E8A: "rp2040",        # Raspberry Pi (Pico)
    0x0483: "stm32",         # STMicroelectronics (STM32)
    0x1D50: "generic",       # OpenMoko (Black Magic Probe, etc.)
    0x2341: "generic",       # Arduino
    0x239A: "generic",       # Adafruit
    0x303A: "espressif",     # Espressif native USB (ESP32-S2/S3)
}


def detect_chip_from_usb(vid: int, pid: int, desc: str) -> str | None:
    """Detect chip type from USB vendor/product ID and description.
    Instant — no serial communication needed."""
    if vid == 0x2E8A:
        # Raspberry Pi — RP2040 or RP2350
        if pid == 0x0005:
            return "rp2040"       # MicroPython / CDC mode
        if pid == 0x000A:
            return "rp2040"       # Pico SDK CDC
        if pid == 0x0003 or pid == 0x0004:
            return "rp2040"       # BOOTSEL mode
        return "rp2040"           # any Raspberry Pi VID = RP2040 family

    if vid == 0x0483:
        return "stm32"           # STMicroelectronics

    if vid == 0x303A:
        # Espressif native USB (ESP32-S2, S3, C3, C6)
        return "esp32s3"         # most common, refine with esptool if needed

    # For CH340/CP2102/FTDI — could be ESP32 or ESP8266, need esptool
    return None


def detect_chip(port: str) -> str | None:
    """Detect the chip type on a serial port.
    First tries USB VID/PID (instant), then falls back to esptool (slower)."""
    # Try USB VID/PID first (from pyserial port info)
    try:
        import serial.tools.list_ports
        for p in serial.tools.list_ports.comports():
            if p.device == port:
                vid = p.vid or 0
                pid = p.pid or 0
                chip = detect_chip_from_usb(vid, pid, p.description or "")
                if chip:
                    return chip
                break
    except ImportError:
        pass

    # Fall back to esptool for Espressif chips (CH340/CP2102)
    try:
        result = subprocess.run(
            [sys.executable, "-m", "esptool", "--port", port, "chip-id"],
            capture_output=True, text=True, timeout=10,
        )
        output = result.stdout + result.stderr
        for line in output.splitlines():
            low = line.lower()
            if "detecting chip type" in low or "chip type:" in low:
                for chip in ["esp32s3", "esp32s2", "esp32c3", "esp32c6", "esp32h2", "esp32", "esp8266"]:
                    if chip in low.replace("-", "").replace(" ", ""):
                        return chip
    except (subprocess.TimeoutExpired, FileNotFoundError, Exception):
        pass
    return None


def find_serial_ports() -> list[dict]:
    """Find all connected microcontroller serial ports. Cross-platform.
    Returns list of {'port': str, 'desc': str, 'chip': str|None}."""
    devices = []
    try:
        import serial.tools.list_ports
        for port in serial.tools.list_ports.comports():
            desc = (port.description or "").lower()
            vid = port.vid or 0

            is_mcu = False
            # Check known MCU vendor IDs
            if vid in _MCU_VIDS:
                is_mcu = True
            # Check known USB-serial chip names in description
            if any(chip in desc for chip in ["cp210", "ch340", "ch910", "ftdi"]):
                is_mcu = True
            # ACM ports (Pico, STM32 native USB) are always MCUs
            if "ttyACM" in port.device or "ACM" in (port.description or ""):
                is_mcu = True

            if is_mcu:
                chip = detect_chip(port.device)
                devices.append({
                    "port": port.device,
                    "desc": port.description or "",
                    "chip": chip,
                })
    except ImportError:
        pass

    # Fallback: check common paths if pyserial not available
    if not devices:
        platform = get_platform()
        if platform == "windows":
            for i in range(3, 11):
                p = f"COM{i}"
                try:
                    import serial
                    s = serial.Serial(p)
                    s.close()
                    chip = detect_chip(p)
                    devices.append({"port": p, "desc": "Serial", "chip": chip})
                except:
                    continue
        else:
            for p in ["/dev/ttyUSB0", "/dev/ttyUSB1", "/dev/ttyACM0", "/dev/ttyACM1"]:
                if Path(p).exists():
                    chip = detect_chip(p)
                    devices.append({"port": p, "desc": "Serial", "chip": chip})

    return devices


def find_serial_port() -> str | None:
    """Auto-detect first microcontroller serial port. Cross-platform."""
    devices = find_serial_ports()
    if devices:
        return devices[0]["port"]
    return None


# ============================================================
# IDF management
# ============================================================

IDF_VERSION = "v5.4.1"
IDF_REPO = "https://github.com/espressif/esp-idf.git"


def is_idf_installed() -> bool:
    """Check if ESP-IDF is available and usable."""
    idf = idf_path()
    return (idf / "tools" / "idf.py").exists()


def install_idf(on_progress=None):
    """Download and install ESP-IDF into ~/.volt/toolchains/esp-idf.
    This is a long operation (1-2 GB download)."""
    target = volt_toolchains() / "esp-idf"

    if target.exists():
        return  # already installed

    target.parent.mkdir(parents=True, exist_ok=True)

    # Step 1: Clone ESP-IDF
    if on_progress:
        on_progress("Cloning ESP-IDF (this may take a few minutes)...")

    subprocess.run(
        ["git", "clone", "--depth", "1", "--branch", IDF_VERSION,
         "--filter=blob:none", IDF_REPO, str(target)],
        check=True,
    )

    # Step 2: Install toolchain
    if on_progress:
        on_progress("Installing toolchain...")

    platform = get_platform()
    if platform == "windows":
        install_script = target / "install.bat"
        subprocess.run(["cmd", "/c", str(install_script), "esp32"], check=True)
    else:
        install_script = target / "install.sh"
        subprocess.run(["bash", str(install_script), "esp32"], check=True)

    # Step 3: Fetch required submodules
    if on_progress:
        on_progress("Fetching submodules...")

    subprocess.run(
        ["git", "submodule", "update", "--init", "--depth", "1",
         "components/heap/tlsf", "components/json/cJSON",
         "components/lwip/lwip", "components/mbedtls/mbedtls",
         "components/mqtt/esp-mqtt", "components/protobuf-c/protobuf-c",
         "components/spiffs/spiffs", "components/unity/unity",
         "components/esp_wifi/lib"],
        cwd=str(target),
        check=True,
    )

    if on_progress:
        on_progress("ESP-IDF installed successfully.")


def print_paths():
    """Print all resolved paths for debugging."""
    print(f"Platform:     {get_platform()}")
    print(f"Volt home:    {volt_home()}")
    print(f"  bin:        {volt_bin()}")
    print(f"  sdk:        {volt_sdk()}")
    print(f"  toolchains: {volt_toolchains()}")
    print(f"  cache:      {volt_cache()}")
    print(f"  config:     {volt_config()}")
    print(f"ESP-IDF:      {idf_path()}")
    root = find_project_root()
    if root:
        print(f"Project root: {root}")
        print(f"  build:      {project_build_dir(root)}")
    else:
        print(f"Project root: (not in a Volt project)")
