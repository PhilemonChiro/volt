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
    """Copy framework headers and sources into ~/.volt/sdk/.
    Called during `pip install` or `volt setup`."""
    sdk = volt_sdk()

    # Copy headers
    include_src = source_framework_dir / "include" / "volt"
    include_dst = sdk / "include" / "volt"
    if include_src.exists():
        include_dst.mkdir(parents=True, exist_ok=True)
        for f in include_src.glob("*.h"):
            shutil.copy2(f, include_dst / f.name)

    # Copy sources
    src_dir = source_framework_dir / "src"
    dst_dir = sdk / "src"
    if src_dir.exists():
        dst_dir.mkdir(parents=True, exist_ok=True)
        for f in src_dir.glob("*.c"):
            shutil.copy2(f, dst_dir / f.name)

    # Copy CMakeLists
    cmake = source_framework_dir / "CMakeLists.txt"
    if cmake.exists():
        shutil.copy2(cmake, sdk / "CMakeLists.txt")

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


def detect_chip(port: str) -> str | None:
    """Detect the chip type on a serial port using esptool.
    Returns: 'esp32', 'esp8266', 'esp32s2', 'esp32s3', 'esp32c3', etc. or None."""
    try:
        result = subprocess.run(
            [sys.executable, "-m", "esptool", "--port", port, "chip-id"],
            capture_output=True, text=True, timeout=10,
        )
        output = result.stdout + result.stderr
        # esptool prints "Detecting chip type... ESP8266" or "ESP32" etc.
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
            if any(chip in desc for chip in ["cp210", "ch340", "ch910", "ftdi"]):
                is_mcu = True
            if vid in (0x10C4, 0x1A86, 0x0403):  # Silicon Labs, WCH, FTDI
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
