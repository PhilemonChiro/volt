#!/usr/bin/env python3
"""
Volt CLI — Build, flash, and monitor Volt programs for embedded systems.
"""

import sys
import os
import subprocess
import time
from pathlib import Path

import click
from rich.console import Console
from rich.table import Table
from rich.syntax import Syntax
from rich.panel import Panel

# Resolve paths — works both installed (pip) and development (source tree)
_THIS_DIR = Path(__file__).resolve().parent
VOLT_PKG_DIR = _THIS_DIR.parent  # src/volt/

# Project root: walk up to find the repo root (has framework/)
# In pip-installed mode, framework lives in ~/.volt/sdk/
_dev_root = VOLT_PKG_DIR.parent.parent
if (_dev_root / "framework").exists():
    VOLT_ROOT = _dev_root  # development mode
else:
    VOLT_ROOT = Path.home() / ".volt"  # installed mode

COMPILER_DIR = VOLT_PKG_DIR / "compiler"

# Framework: prefer project-local, then ~/.volt/sdk, then dev tree
def _find_framework():
    from volt.paths import volt_sdk
    for candidate in [VOLT_ROOT / "framework", volt_sdk()]:
        if candidate.exists():
            return candidate
    return VOLT_ROOT / "framework"  # fallback

FRAMEWORK_DIR = _find_framework()

# IDF path: respect env vars, then check common locations
from volt.paths import idf_path as _resolve_idf
IDF_PATH = _resolve_idf()

console = Console()


# ============================================================
# Helpers
# ============================================================

def find_volt_source() -> Path:
    volts = list(Path(".").glob("*.volt"))
    if not volts:
        volts = list(Path(".").glob("**/*.volt"))
    if not volts:
        console.print("[red]No .volt file found in current directory.[/red]")
        raise SystemExit(1)
    for v in volts:
        if v.name == "main.volt":
            return v
    return volts[0]


def find_port() -> str:
    from volt.paths import find_serial_ports
    devices = find_serial_ports()
    if devices:
        d = devices[0]
        chip = d.get("chip") or "unknown"
        console.print(f"[dim]Detected {chip.upper()} on {d['port']}[/dim]")
        return d["port"]
    console.print("[red]No device found. Is a microcontroller connected?[/red]")
    raise SystemExit(1)


def get_idf_env() -> dict:
    from volt.paths import get_idf_env as _get_env
    return _get_env()


def fmt_time(seconds: float) -> str:
    if seconds < 1:
        return f"{seconds*1000:.0f}ms"
    return f"{seconds:.1f}s"


def fmt_bar(pct: float, width: int = 20) -> str:
    filled = int(pct / 100 * width)
    empty = width - filled
    color = "green" if pct < 60 else "yellow" if pct < 80 else "red"
    return f"[{color}]{'█' * filled}{'░' * empty}[/{color}] {pct:.1f}%"


# ============================================================
# Commands
# ============================================================

def preflight_check(command: str):
    """Check prerequisites before running a command. Auto-fix what's missing."""
    from volt.paths import volt_home, volt_sdk, is_idf_installed, ensure_volt_home, install_sdk

    # Commands that don't need any setup
    if command in ("setup", "paths", "new", "fmt", "--help", "-h", "help", "--version"):
        return

    # Ensure ~/.volt/ exists
    if not volt_home().exists():
        console.print(f"[cyan]→[/cyan] First run — setting up Volt platform...")
        ensure_volt_home()
        framework_dir = VOLT_ROOT / "framework"
        if framework_dir.exists():
            install_sdk(framework_dir)
        console.print(f"[green]✓[/green] Platform initialized at {volt_home()}\n")

    # Check SDK installed
    if not (volt_sdk() / "include" / "volt" / "volt.h").exists():
        console.print(f"[cyan]→[/cyan] Installing SDK...")
        ensure_volt_home()
        framework_dir = VOLT_ROOT / "framework"
        if framework_dir.exists():
            install_sdk(framework_dir)
            console.print(f"[green]✓[/green] SDK installed\n")

    # Commands that need a toolchain
    if command in ("build", "flash", "run", "watch"):
        if not is_idf_installed():
            # Check if ESP8266 SDK is available instead
            from volt.paths import volt_toolchains
            esp8266_sdk = volt_toolchains() / "esp8266-rtos-sdk"
            if not (esp8266_sdk / "export.sh").exists():
                console.print(f"\n[yellow]No toolchain found.[/yellow]")
                console.print(f"Volt needs a toolchain to compile firmware.\n")
                console.print(f"Run [cyan]volt setup[/cyan] with a device plugged in to auto-install.\n")
                raise SystemExit(1)


@click.group()
@click.version_option("0.1.0", prog_name="volt")
@click.pass_context
def cli(ctx):
    """Volt — A typed, hardware-aware language for embedded systems."""
    # Run preflight check for the subcommand being invoked
    if ctx.invoked_subcommand:
        preflight_check(ctx.invoked_subcommand)


@cli.command()
@click.option("--chip", default=None, help="Chip to set up (auto-detected if not specified)")
def setup(chip):
    """Initialize Volt platform and install toolchains for connected devices."""
    from volt.paths import (ensure_volt_home, install_sdk, volt_home, volt_sdk,
                             find_serial_ports, volt_toolchains,
                             is_idf_installed, install_idf as do_install_idf)

    console.print(f"\n[bold cyan]Volt Setup[/bold cyan]\n")

    # Step 1: Create ~/.volt/
    ensure_volt_home()
    console.print(f"  [green]✓[/green] Platform directory: {volt_home()}")

    # Step 2: Install SDK framework
    framework_dir = VOLT_ROOT / "framework"
    if framework_dir.exists():
        install_sdk(framework_dir)
        console.print(f"  [green]✓[/green] SDK installed")
    else:
        console.print(f"  [yellow]![/yellow] Framework not found at {framework_dir}")

    # Step 3: Detect connected devices
    console.print(f"\n  [cyan]Scanning for devices...[/cyan]")
    devices = find_serial_ports()

    if not devices and not chip:
        console.print(f"  [yellow]![/yellow] No devices detected.")
        console.print(f"    Plug in a board and run [cyan]volt setup[/cyan] again.")
        console.print(f"    Or specify manually: [cyan]volt setup --chip esp32[/cyan]\n")
        return

    # Build list of chips to set up
    chips_to_setup = set()
    if chip:
        chips_to_setup.add(chip.lower())
    else:
        for d in devices:
            if d.get("chip"):
                chips_to_setup.add(d["chip"])
                console.print(f"  [green]✓[/green] Found [bold]{d['chip'].upper()}[/bold] on {d['port']}")

    if not chips_to_setup:
        console.print(f"  [yellow]![/yellow] Could not identify chip type.")
        console.print(f"    Specify manually: [cyan]volt setup --chip esp32[/cyan]\n")
        return

    # Step 4: Install toolchains for each detected chip
    for chip_name in sorted(chips_to_setup):
        console.print(f"\n  [cyan]Setting up {chip_name.upper()} toolchain...[/cyan]")

        if chip_name in ("esp32", "esp32s2", "esp32s3", "esp32c3", "esp32c6", "esp32h2"):
            # ESP32 family — uses ESP-IDF
            if is_idf_installed():
                console.print(f"  [green]✓[/green] ESP-IDF already installed")
            else:
                console.print(f"  [cyan]→[/cyan] Downloading ESP-IDF (this takes several minutes)...")
                try:
                    do_install_idf(on_progress=lambda msg: console.print(f"    {msg}"))
                    console.print(f"  [green]✓[/green] ESP-IDF installed")
                except Exception as e:
                    console.print(f"  [red]✗[/red] ESP-IDF install failed: {e}")

        elif chip_name == "esp8266":
            # ESP8266 — uses ESP8266 RTOS SDK
            sdk_path = volt_toolchains() / "esp8266-rtos-sdk"
            if (sdk_path / "export.sh").exists():
                console.print(f"  [green]✓[/green] ESP8266 SDK already installed")
            else:
                console.print(f"  [cyan]→[/cyan] Downloading ESP8266 SDK...")
                try:
                    import subprocess as sp
                    sp.run(["git", "clone", "--depth", "1",
                            "https://github.com/espressif/ESP8266_RTOS_SDK.git",
                            str(sdk_path)], check=True,
                           capture_output=True)
                    console.print(f"  [green]✓[/green] SDK cloned")

                    console.print(f"  [cyan]→[/cyan] Installing toolchain (this takes a few minutes)...")
                    sp.run([sys.executable, str(sdk_path / "tools" / "idf_tools.py"), "install"],
                           check=True, capture_output=True)
                    console.print(f"  [green]✓[/green] Toolchain installed")

                    # Install Python requirements
                    sp.run([sys.executable, "-m", "pip", "install", "--break-system-packages",
                            "-r", str(sdk_path / "requirements.txt")],
                           capture_output=True)
                    console.print(f"  [green]✓[/green] Python dependencies installed")
                except Exception as e:
                    console.print(f"  [red]✗[/red] ESP8266 setup failed: {e}")

        else:
            console.print(f"  [yellow]![/yellow] Toolchain for {chip_name} not yet available")
            console.print(f"    Supported: esp32, esp8266")

    # Step 5: Pre-build SDK cache (so first `volt build` is fast)
    console.print(f"\n  [cyan]Pre-building SDK cache (so first build is fast)...[/cyan]")
    console.print(f"  [dim]This takes 3-5 minutes but only happens once per chip.[/dim]")
    for chip_name in sorted(chips_to_setup):
        if chip_name in ("esp32", "esp8266"):
            _prebuild_sdk_cache(chip_name)

    console.print(f"\n[bold green]✓[/bold green] Volt setup complete!\n")
    console.print(f"  Create a project:  [cyan]volt new my-project[/cyan]")
    console.print(f"  Build:             [cyan]volt build[/cyan]")
    console.print(f"  Flash:             [cyan]volt flash[/cyan]")
    console.print(f"  Monitor:           [cyan]volt monitor[/cyan]\n")


def _prebuild_sdk_cache(chip_name: str):
    """Build a minimal dummy project to cache SDK compilation."""
    import tempfile, subprocess as sp, shutil

    tmp = Path(tempfile.mkdtemp(prefix=f"volt-prebuild-{chip_name}-"))
    try:
        (tmp / "main").mkdir()

        # Minimal main.c
        (tmp / "main" / "main.c").write_text(
            '#include <stdio.h>\nvoid app_main(void) { printf("ok\\n"); }\n'
        )

        if chip_name == "esp32":
            from volt.paths import idf_path
            idf = idf_path()
            (tmp / "CMakeLists.txt").write_text(
                f'cmake_minimum_required(VERSION 3.16)\n'
                f'include({idf}/tools/cmake/project.cmake)\n'
                f'project(volt_prebuild)\n'
            )
            (tmp / "main" / "CMakeLists.txt").write_text(
                'idf_component_register(SRCS "main.c" INCLUDE_DIRS ".")\n'
            )
            env = os.environ.copy()
            env["IDF_PATH"] = str(idf)
            result = sp.run(
                ["bash", "-c", f"source {idf}/export.sh 2>/dev/null && idf.py build"],
                cwd=str(tmp), capture_output=True, text=True, env=env, timeout=600
            )

        elif chip_name == "esp8266":
            from volt.paths import volt_toolchains
            sdk = volt_toolchains() / "esp8266-rtos-sdk"
            (tmp / "CMakeLists.txt").write_text(
                f'cmake_minimum_required(VERSION 3.16)\n'
                f'include($ENV{{IDF_PATH}}/tools/cmake/project.cmake)\n'
                f'project(volt_prebuild)\n'
            )
            (tmp / "main" / "CMakeLists.txt").write_text(
                'idf_component_register(SRCS "main.c" INCLUDE_DIRS ".")\n'
            )
            result = sp.run(
                ["bash", "-c",
                 f"export IDF_PATH={sdk} && source $IDF_PATH/export.sh 2>/dev/null && idf.py build"],
                cwd=str(tmp), capture_output=True, text=True, timeout=600
            )

        if result.returncode == 0:
            console.print(f"  [green]✓[/green] {chip_name.upper()} SDK cache built")
        else:
            console.print(f"  [yellow]![/yellow] {chip_name.upper()} pre-build had issues (builds may be slower)")
    except Exception as e:
        console.print(f"  [yellow]![/yellow] Pre-build skipped: {e}")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


@cli.command()
def paths():
    """Show all Volt platform paths."""
    from volt.paths import print_paths
    print()
    print_paths()
    print()


@cli.command()
@click.argument("name")
@click.option("--chip", default=None, help="Target chip (auto-detected if not specified)")
def new(name, chip):
    """Create a new Volt project."""
    project_dir = Path(name)
    if project_dir.exists():
        console.print(f"[red]Directory '{name}' already exists.[/red]")
        raise SystemExit(1)

    # Auto-detect chip if not specified
    if not chip:
        from volt.paths import find_serial_ports
        devices = find_serial_ports()
        if devices and devices[0].get("chip"):
            chip = devices[0]["chip"]
            console.print(f"  [dim]Detected {chip.upper()} on {devices[0]['port']}[/dim]")
        else:
            chip = "esp32"  # default fallback
            console.print(f"  [dim]No device detected, defaulting to esp32[/dim]")

    # Chip-specific defaults
    chip_defaults = {
        "esp32":   {"led_pin": "2",  "has_wifi": True},
        "esp8266": {"led_pin": "2",  "has_wifi": True},
        "stm32f103": {"led_pin": "PC13", "has_wifi": False},
        "rp2040":  {"led_pin": "GP25", "has_wifi": False},
    }
    defaults = chip_defaults.get(chip, {"led_pin": "2", "has_wifi": True})

    project_dir.mkdir(parents=True)
    (project_dir / "build").mkdir()
    (project_dir / ".volt").mkdir()

    # Generate starter code based on chip
    wifi_block = ""
    if defaults["has_wifi"]:
        wifi_block = """
    // wifi.connect("MyNetwork", "MyPassword")
    // mqtt.connect("mqtt://broker.local")"""

    (project_dir / "main.volt").write_text(f"""chip {chip}

hardware {{
    pin led: Output = {defaults['led_pin']}
}}

task blink() {{
    every 500ms {{
        led.toggle()
    }}
}}

main {{{wifi_block}
    run(blink)
}}
""")

    (project_dir / "volt.toml").write_text(f"""[project]
name = "{name}"
version = "0.1.0"
chip = "{chip}"

[build]
# flash_size = "4MB"
# cpu_freq = 240
""")

    (project_dir / ".gitignore").write_text("""build/
.volt/
""")

    console.print(f"\n[bold green]✓[/bold green] Created project [bold]{name}[/bold] for [bold]{chip.upper()}[/bold]\n")
    console.print(f"  {project_dir}/")
    console.print(f"  ├── main.volt      [dim]← your code (pin {defaults['led_pin']} = onboard LED)[/dim]")
    console.print(f"  ├── volt.toml      [dim]← project config[/dim]")
    console.print(f"  ├── build/         [dim]← generated files[/dim]")
    console.print(f"  └── .gitignore")
    console.print()
    console.print(f"  [cyan]cd {name}[/cyan]")
    console.print(f"  [cyan]volt build[/cyan]")
    console.print(f"  [cyan]volt flash[/cyan]")
    console.print(f"  [cyan]volt monitor[/cyan]")
    console.print()


@cli.command()
@click.option("--show", "--show-generated", is_flag=True, help="Print generated C code")
def build(show):
    """Compile .volt → C → ESP32 binary."""
    volt_file = find_volt_source()
    total_start = time.perf_counter()

    # Step 1: Transpile
    console.print(f"\n[bold cyan]→[/bold cyan] Compiling [bold]{volt_file}[/bold]")

    t0 = time.perf_counter()
    # import from package
    from volt.compiler.voltc import compile_volt

    source = volt_file.read_text()
    c_code, errors = compile_volt(source, str(volt_file))
    t_transpile = time.perf_counter() - t0

    # Print errors/warnings
    if errors.count > 0:
        console.print(errors.report(str(volt_file)))

    if errors.has_errors:
        error_count = sum(1 for e in errors.errors if e.severity == "error")
        console.print(f"\n[red]✗ {error_count} error(s). Build failed.[/red]\n")
        raise SystemExit(1)

    warn_count = sum(1 for e in errors.errors if e.severity == "warning")

    # Write generated C
    output_c = FRAMEWORK_DIR / "main" / "main.c"
    output_c.write_text(c_code)

    console.print(f"  [green]Transpile[/green]  {volt_file.name} {'.' * (30 - len(volt_file.name))} [dim]{fmt_time(t_transpile)}[/dim]")

    if show:
        console.print()
        syntax = Syntax(c_code, "c", theme="monokai", line_numbers=True)
        console.print(Panel(syntax, title="Generated C", border_style="cyan"))
        console.print()

    # Step 2: Build with ESP-IDF
    t1 = time.perf_counter()

    with console.status("[bold cyan]Building with ESP-IDF...[/bold cyan]"):
        env = get_idf_env()
        result = subprocess.run(
            ["idf.py", "build"],
            cwd=str(FRAMEWORK_DIR),
            env=env,
            capture_output=True, text=True,
        )

    t_build = time.perf_counter() - t1

    if result.returncode != 0:
        for line in result.stdout.splitlines():
            if "error:" in line.lower():
                console.print(f"  [red]{line.strip()}[/red]")
        console.print(f"\n[red]✗ ESP-IDF build failed.[/red]\n")
        raise SystemExit(1)

    console.print(f"  [green]Compile[/green]    C → binary {'.' * 20} [dim]{fmt_time(t_build)}[/dim]")

    # Step 3: Parse size info
    flash_size = None
    ram_size = None
    for line in result.stdout.splitlines():
        if "binary size" in line.lower() and "volt-framework" in line:
            # Parse: volt-framework.bin binary size 0x2da70 bytes. Smallest app partition is 0x100000 bytes.
            parts = line.strip().split()
            for i, p in enumerate(parts):
                if p == "size":
                    try:
                        flash_size = int(parts[i+1], 16) if parts[i+1].startswith("0x") else int(parts[i+1])
                    except:
                        pass

    # Show size report
    if flash_size:
        total_flash = 4 * 1024 * 1024  # 4MB
        flash_pct = flash_size * 100 / total_flash
        console.print(f"\n  [bold]Flash:[/bold] {fmt_bar(flash_pct)} ({flash_size // 1024} KB / {total_flash // 1024} KB)")

    total_time = time.perf_counter() - total_start
    console.print(f"\n[bold green]✓[/bold green] Build successful in {fmt_time(total_time)}", end="")
    if warn_count > 0:
        console.print(f" [yellow]({warn_count} warning{'s' if warn_count > 1 else ''})[/yellow]")
    else:
        console.print()
    console.print()


@cli.command()
@click.option("--port", default=None, help="Serial port")
def flash(port):
    """Flash the compiled binary to ESP32."""
    from rich.progress import Progress, BarColumn, TextColumn, TimeElapsedColumn

    if port is None:
        port = find_port()

    console.print(f"\n[bold cyan]→[/bold cyan] Flashing to [bold]{port}[/bold]")

    t0 = time.perf_counter()
    env = get_idf_env()

    # Stream esptool output to parse real-time progress (Writing at ... XX%)
    process = subprocess.Popen(
        ["idf.py", "-p", port, "flash"],
        cwd=str(FRAMEWORK_DIR),
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
    )

    with Progress(
        TextColumn("  [bold cyan]Flashing[/bold cyan]"),
        BarColumn(bar_width=30),
        TextColumn("[bold]{task.percentage:>3.0f}%[/bold]"),
        TimeElapsedColumn(),
        console=console,
        transient=True,
    ) as progress:
        task = progress.add_task("flash", total=100)
        last_pct = 0

        for line in process.stdout:
            line = line.strip()
            # Parse "Writing at 0x000XXXXX... (XX %)" from esptool
            if "Writing at" in line and "%" in line:
                try:
                    pct_str = line.split("(")[1].split("%")[0].strip()
                    pct = int(pct_str)
                    if pct > last_pct:
                        progress.update(task, completed=pct)
                        last_pct = pct
                except:
                    pass
            elif "Hash of data verified" in line:
                progress.update(task, completed=100)

    process.wait()
    elapsed = time.perf_counter() - t0

    if process.returncode != 0:
        console.print(f"\n[red]✗ Flash failed.[/red]\n")
        raise SystemExit(1)

    console.print(f"[bold green]✓[/bold green] Flashed in {fmt_time(elapsed)}\n")


@cli.command()
@click.option("--port", default=None, help="Serial port")
@click.option("--filter", "log_filter", default=None, help="Filter log output by keyword")
def monitor(port, log_filter):
    """Watch serial output from ESP32."""
    if port is None:
        port = find_port()

    console.print(f"\n[bold cyan]→[/bold cyan] Monitoring [bold]{port}[/bold] [dim](Ctrl+C to stop)[/dim]\n")

    try:
        import serial
        ser = serial.Serial(port, 115200, timeout=1)

        while True:
            line = ser.readline()
            if line:
                try:
                    text = line.decode('utf-8', errors='replace').rstrip()
                    if not text:
                        continue
                    if log_filter and log_filter.lower() not in text.lower():
                        continue
                    # Color-code by log level
                    if "[ERROR]" in text or "error" in text.lower():
                        console.print(f"[red]{text}[/red]")
                    elif "[WARN" in text:
                        console.print(f"[yellow]{text}[/yellow]")
                    elif "[DEBUG]" in text:
                        console.print(f"[dim]{text}[/dim]")
                    else:
                        print(text)
                except:
                    pass
    except KeyboardInterrupt:
        console.print(f"\n[dim]Monitor stopped.[/dim]\n")
    except ImportError:
        console.print("[red]pyserial not installed. Run: pip install pyserial[/red]")
        raise SystemExit(1)


@cli.command()
@click.option("--port", default=None, help="Serial port")
def run(port):
    """Build + flash + monitor in one command."""
    # Build
    ctx = click.Context(build)
    ctx.invoke(build, show=False)

    # Flash
    if port is None:
        port = find_port()
    ctx = click.Context(flash)
    ctx.invoke(flash, port=port)

    # Monitor
    ctx = click.Context(monitor)
    ctx.invoke(monitor, port=port, log_filter=None)


@cli.command()
def check():
    """Type check and hardware validate without building."""
    volt_file = find_volt_source()

    console.print(f"\n[bold cyan]→[/bold cyan] Checking [bold]{volt_file}[/bold]")

    t0 = time.perf_counter()
    # import from package
    from volt.compiler.voltc import compile_volt

    source = volt_file.read_text()
    c_code, errors = compile_volt(source, str(volt_file))
    elapsed = time.perf_counter() - t0

    if errors.count > 0:
        console.print(errors.report(str(volt_file)))

    if errors.has_errors:
        error_count = sum(1 for e in errors.errors if e.severity == "error")
        console.print(f"\n[red]✗ {error_count} error(s) found.[/red]\n")
        raise SystemExit(1)

    warn_count = sum(1 for e in errors.errors if e.severity == "warning")
    console.print(f"[bold green]✓[/bold green] Check passed in {fmt_time(elapsed)}", end="")
    if warn_count > 0:
        console.print(f" [yellow]({warn_count} warning{'s' if warn_count > 1 else ''})[/yellow]")
    else:
        console.print()
    console.print()


@cli.command()
@click.option("--flash", "auto_flash", is_flag=True, help="Auto-flash after successful build")
@click.option("--port", default=None, help="Serial port for --flash")
def watch(auto_flash, port):
    """Watch .volt files and auto-rebuild on change."""
    volt_file = find_volt_source()

    console.print(f"\n[bold cyan]→[/bold cyan] Watching [bold]{volt_file}[/bold] for changes [dim](Ctrl+C to stop)[/dim]\n")

    last_mtime = 0

    try:
        while True:
            try:
                mtime = volt_file.stat().st_mtime
            except:
                time.sleep(0.5)
                continue

            if mtime > last_mtime:
                if last_mtime > 0:
                    console.print(f"\n[dim]─── File changed ───[/dim]\n")

                last_mtime = mtime

                # Build
                try:
                    ctx = click.Context(build)
                    ctx.invoke(build, show=False)

                    if auto_flash:
                        flash_port = port or find_port()
                        ctx = click.Context(flash)
                        ctx.invoke(flash, port=flash_port)
                except SystemExit:
                    console.print(f"\n[yellow]Waiting for changes...[/yellow]")

            time.sleep(0.5)

    except KeyboardInterrupt:
        console.print(f"\n[dim]Watch stopped.[/dim]\n")


@cli.command()
@click.argument("files", nargs=-1)
@click.option("--check", "check_only", is_flag=True, help="Check formatting without changing files")
def fmt(files, check_only):
    """Format .volt files (like gofmt)."""
    from pathlib import Path

    # Find files to format
    targets = []
    if files:
        targets = [Path(f) for f in files]
    else:
        targets = list(Path(".").rglob("*.volt"))

    if not targets:
        console.print("[yellow]No .volt files found.[/yellow]")
        return

    changed = 0
    for filepath in targets:
        if not filepath.exists():
            console.print(f"[red]Not found: {filepath}[/red]")
            continue

        original = filepath.read_text()
        formatted = format_volt(original)

        if original == formatted:
            continue

        changed += 1
        if check_only:
            console.print(f"[yellow]Would format:[/yellow] {filepath}")
        else:
            filepath.write_text(formatted)
            console.print(f"[green]Formatted:[/green] {filepath}")

    if check_only:
        if changed:
            console.print(f"\n[yellow]{changed} file(s) need formatting.[/yellow]")
            raise SystemExit(1)
        else:
            console.print(f"[green]✓[/green] All {len(targets)} file(s) already formatted.")
    else:
        if changed:
            console.print(f"\n[green]✓[/green] Formatted {changed} file(s).")
        else:
            console.print(f"[green]✓[/green] All {len(targets)} file(s) already formatted.")


def format_volt(source: str) -> str:
    """Format Volt source code — consistent indentation, clean spacing."""
    lines = source.split('\n')
    result = []
    indent = 0
    tab = '    '
    prev_blank = False

    for line in lines:
        stripped = line.strip()

        # Collapse multiple blank lines into one
        if not stripped:
            if not prev_blank and result:
                result.append('')
            prev_blank = True
            continue
        prev_blank = False

        # Decrease indent before closing brace
        if stripped.startswith('}'):
            indent = max(0, indent - 1)

        result.append(tab * indent + stripped)

        # Increase indent after opening brace
        if stripped.endswith('{'):
            indent += 1

    # Ensure single trailing newline
    while result and result[-1] == '':
        result.pop()
    result.append('')

    return '\n'.join(result)


@cli.command()
def devices():
    """List connected microcontroller devices."""
    from volt.paths import find_serial_ports

    console.print("\n[dim]Scanning ports...[/dim]")
    devs = find_serial_ports()

    if not devs:
        console.print("[yellow]No devices found. Is a microcontroller connected?[/yellow]\n")
        return

    table = Table(title="Connected Devices")
    table.add_column("Port", style="cyan")
    table.add_column("Chip", style="green bold")
    table.add_column("Description", style="white")

    for d in devs:
        chip = (d.get("chip") or "unknown").upper()
        table.add_row(d["port"], chip, d.get("desc", ""))

    console.print()
    console.print(table)
    console.print()


def main():
    """Entry point for `pip install` and `pyproject.toml` scripts."""
    cli()


if __name__ == "__main__":
    main()
