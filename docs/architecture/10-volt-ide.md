# 10 — Volt IDE

## Overview

Volt IDE is a purpose-built development environment for Volt embedded programs. Not a plugin for another editor — a standalone application designed from the ground up for embedded development.

**Philosophy: Three clicks from launch to running on hardware.**

Open IDE → Plug in board → Click Flash → Code runs. No setup wizard, no toolchain installation, no configuration files, no "select board from dropdown."

### Why a Custom IDE

| | Arduino IDE | VS Code + Extension | PlatformIO | **Volt IDE** |
|--|-------------|--------------------|-----------|----|
| Download size | 300MB | 200MB + ext | 200MB + ext | **15MB** |
| RAM usage | 400MB | 500MB+ | 500MB+ | **50MB** |
| Startup time | 5-8s | 3-5s | 5-10s | **<1s** |
| Setup steps | 3 | 5+ | 4+ | **0** |
| Pin map | No | No | No | **Yes, live** |
| State machine viz | No | No | No | **Yes, from code** |
| Crash decoder | No | Plugin | Plugin | **Built in** |
| Hardware autocomplete | No | Basic | Basic | **Chip-aware** |

---

## Tech Stack

### Tauri v2 (Rust backend + Web frontend)

Not Electron. Tauri uses the system's native webview instead of bundling Chromium.

- **Binary size**: 10-15MB (Electron: 200MB+)
- **RAM usage**: 30-50MB (Electron: 300MB+)
- **Startup**: <1 second (Electron: 3-5s)
- **Backend**: Rust — fast, safe, no GC pauses
- **Frontend**: HTML/CSS/JS in system webview
- **Cross-platform**: Linux, macOS, Windows from one codebase

```
┌──────────────────────────────────────┐
│  Frontend (system webview)           │
│  ├── CodeMirror 6 (code editor)      │
│  ├── Custom Volt theme (CSS)         │
│  ├── Sidebar components (vanilla JS) │
│  ├── Pin map renderer (SVG)          │
│  ├── State machine visualizer (SVG)  │
│  └── Serial plotter (Canvas 2D)      │
├──────────────────────────────────────┤
│  Backend (Rust via Tauri v2 IPC)     │
│  ├── serialport — serial I/O         │
│  ├── File system — project mgmt      │
│  ├── Process spawning — build/flash   │
│  ├── LSP client — talks to volt LSP  │
│  ├── USB detection — udev/IOKit/WMI  │
│  └── ELF parser — crash decode       │
├──────────────────────────────────────┤
│  Volt Toolchain (existing Python)    │
│  ├── Compiler (7-pass pipeline)      │
│  ├── LSP server (pygls)              │
│  ├── SDK management (~/.volt/)       │
│  └── esptool / picotool              │
└──────────────────────────────────────┘
```

### Why CodeMirror 6 (not Monaco)

Monaco is VS Code's editor component — powerful but 5MB and designed for a general-purpose editor. CodeMirror 6 is:

- **500KB** vs 5MB — 10x smaller
- Built for embedding — designed to be put inside other apps
- Highly extensible — custom syntax, custom decorations, custom panels
- Mobile-friendly — works on tablets (future: Volt IDE on iPad?)
- TypeScript-first with clean API

---

## Application Layout

```
┌──────────────────────────────────────────────────────────────┐
│  ⚡ Volt IDE              my-sensor (ESP32)       ─ □ ×     │
├────────────┬─────────────────────────────────────────────────┤
│            │                                                 │
│  DEVICES   │   1  chip esp32                                 │
│  ● ESP32   │   2                                             │
│    /USB1   │   3  hardware {                                 │
│  ● RP2040  │   4      pin led: Output = 2                    │
│    /ACM0   │   5      pin sensor: Analog = 36                │
│            │   6  }                                          │
│────────────│   7                                             │
│            │   8  task blink() {                              │
│  ▶ Build   │   9      every 500ms {                          │
│  ⚡ Flash   │  10          led.toggle()                       │
│  📡 Monitor │  11      }                                      │
│            │  12  }                                          │
│────────────│  13                                             │
│  PROJECT   │  14  main {                                     │
│  my-sensor │  15      wifi.connect("Net", "pass")            │
│  esp32     │  16      run(blink)                             │
│            │  17  }                                          │
│            │                                                 │
├────────────┴─────────────────────────────────────────────────┤
│  SERIAL MONITOR                              ● Live   [Stop] │
│  [00:00:01] INFO  wifi: connected to Net                     │
│  [00:00:02] INFO  mqtt: broker connected                     │
│  [00:00:03] DEBUG blink: toggle #1                           │
│  [00:00:04] DEBUG blink: toggle #2                           │
│                                                              │
├──────────────────────────────────────────────────────────────┤
│ ⚡ ESP32 │ /dev/ttyUSB1 │ ✓ Built 0.8s │ 187KB/4MB │ WiFi ● │
└──────────────────────────────────────────────────────────────┘
```

### Layout Sections

1. **Title bar** — project name, active chip, window controls
2. **Sidebar** (left, 200px) — devices, build/flash/monitor buttons, project info
3. **Editor** (center) — CodeMirror 6 with Volt syntax, inline errors
4. **Serial monitor** (bottom, collapsible, 200px) — live device output
5. **Status bar** (bottom, 24px) — chip, port, build status, memory, connection

---

## Feature Specifications

### 1. Code Editor

#### Syntax Highlighting

Volt-specific token categories:

| Token | Color | Examples |
|-------|-------|---------|
| Keyword | Purple | `chip`, `hardware`, `task`, `machine`, `state`, `func`, `main` |
| Type | Teal | `int`, `float`, `bool`, `string`, `Output`, `Input`, `Analog`, `PWM` |
| Pin name | Green | `led`, `motor`, `sensor` |
| Duration | Orange | `500ms`, `1seconds`, `10ms` |
| String | Brown | `"hello"`, `"mqtt://broker"` |
| Number | Blue | `42`, `3.14`, `0xFF` |
| Comment | Gray | `// this is a comment` |
| Builtin | Cyan | `wifi`, `mqtt`, `storage`, `system`, `log` |
| State | Yellow | `initial`, `enter`, `exit`, `on`, `after` |
| Operator | White | `+`, `-`, `==`, `!=`, `->` |

#### IntelliSense

The LSP server (existing Python `volt_lsp.py`) provides:

**Autocomplete triggers:**

| Context | Trigger | Suggestions |
|---------|---------|------------|
| After `chip ` | Space | All registered chips: `esp32`, `esp8266`, `rp2040`, `stm32f103` |
| After `pin name: ` | `:` | Pin modes: `Output`, `Input`, `Input.PullUp`, `Analog`, `PWM`, `Touch` |
| After `pin name: Output = ` | `=` | Valid GPIO numbers for the declared chip |
| After `led.` | `.` | Methods for pin mode: `toggle()`, `on()`, `off()`, `write()`, `read()` |
| After `wifi.` | `.` | `connect()`, `disconnect()`, `is_connected()` |
| After `mqtt.` | `.` | `connect()`, `send_int()`, `send()`, `is_connected()` |
| After `storage.` | `.` | `save()`, `load()`, `push()`, `drain()`, `list_count()` |
| After `system.` | `.` | `restart()`, `free_heap()`, `uptime()` |
| After `every ` | Space | Duration suggestions: `100ms`, `500ms`, `1seconds`, `5seconds` |
| After `on ` | Space | Event names from the machine's transitions |
| After `-> ` | Space | State names from the current machine |
| Top level | typing | `chip`, `hardware`, `task`, `func`, `machine`, `struct`, `main`, `var`, `let` |

**Hover information:**

| Hover target | Information shown |
|--------------|------------------|
| GPIO number | Full pin capabilities from chip database |
| Pin variable | Mode, GPIO, capabilities, warnings |
| `every 500ms` | Task tier classification + memory cost |
| `strict` | ISR restrictions explained |
| `wifi.connect` | Function signature + chip compatibility |
| Chip name | Architecture, RAM, flash, capabilities |
| State name | Transitions in/out, enter/exit actions |
| Duration literal | Conversion: `5seconds` = 5000ms |

**Diagnostics (real-time):**

Errors and warnings appear as the user types, without needing to build:

- Pin doesn't exist on chip
- Pin conflict (duplicate GPIO)
- Pin can't do requested mode (output on input-only)
- Flash pin usage
- WiFi on no-WiFi chip
- Type mismatch
- Unknown variable/function
- ISR-unsafe call in strict task
- Unreachable state in machine

**Quick fixes (lightbulb menu):**

- Wrong pin mode → "Change to Input"
- Typo in name → "Did you mean `wifi`?"
- Missing chip declaration → "Add `chip esp32`"
- `let` used but mutated → "Change to `var`"

#### Code Formatting

Built-in `volt fmt` — format on save or on demand:

- 4 spaces indent
- Consistent brace style
- Aligned pin declarations
- Sorted hardware block
- Consistent spacing

---

### 2. Hardware Awareness Panel

#### Pin Map Diagram

Interactive SVG rendering of the chip's physical pinout.

**Rendering rules:**
- Generated from the chip's pin database (`src/volt/chips/*.py`)
- Updates live as pins are added/modified in code
- Color coding:
  - Green filled = used in code (working)
  - Red filled = blocked (flash pins, conflicts)
  - Yellow outlined = strapping pin (warning)
  - Gray = available, unused
  - Blue = ADC-capable
- Click an available pin → inserts `pin name: Output = <gpio>` at cursor
- Hover a pin → shows capabilities tooltip

**Per-chip layouts:**

Each chip has its own SVG layout matching the physical board:
- ESP32 DevKit V1 — 30-pin or 38-pin layout
- ESP8266 NodeMCU — 30-pin layout
- Raspberry Pi Pico — 40-pin layout
- STM32 Blue Pill — 40-pin layout (Port.Pin labels)

#### Memory Usage Display

Shows flash and RAM usage, updated after each build:

```
Flash  ████░░░░░░░░░░░░░░░░  187KB / 4MB   (4.6%)
RAM    ██████████████░░░░░░  156KB / 520KB  (30%)

Tasks:
  blink       background    12 bytes
  motor_pid   critical      timer
  telemetry   priority      4096 bytes
```

#### State Machine Visualizer

Generates an SVG diagram from `machine { }` blocks in the code:

- States as rounded rectangles
- Transitions as arrows with labels
- Event triggers shown on arrows
- Timed transitions show duration
- Initial state marked with arrow
- Dead states highlighted red
- During monitoring: current state highlighted green
- Click state/transition → jumps to code

---

### 3. Build System Integration

#### Build (`Ctrl+B`)

1. Calls `volt build` (existing Python CLI)
2. Shows progress in status bar: "Compiling..." → "Building..." → "Linking..."
3. On success: "✓ Built in 0.8s" + memory usage update
4. On failure: errors appear inline in editor + error panel

#### Flash (`Ctrl+Shift+F`)

1. Reads `chip` from project
2. Calls `find_port(target_chip=chip)` — matches project to device
3. If wrong device: "Your project is ESP32 but RP2040 is connected"
4. If no device: "No device found. Plug in your board."
5. Calls appropriate flash tool:
   - ESP32/ESP8266: `esptool.py`
   - RP2040: auto-reboot to BOOTSEL + UF2 copy
   - STM32: `st-flash` or OpenOCD
6. Progress bar with percentage
7. Shows binary size after flash

#### Monitor (`Ctrl+M`)

Toggle serial monitor on/off. When active:
- Reads from the active device's serial port
- Auto-selects baud rate based on chip (74880 for ESP8266, 115200 for others)
- Color-codes log levels
- Filterable by tag
- Searchable
- Pausable
- Exportable to file

---

### 4. Serial Monitor

Always visible at the bottom of the IDE (collapsible).

#### Features

| Feature | Description |
|---------|------------|
| Color coding | INFO=green, WARN=yellow, ERROR=red, DEBUG=gray |
| Tag filtering | Click a tag to filter: `[wifi]`, `[mqtt]`, `[task]` |
| Search | `Ctrl+F` in monitor to find text |
| Timestamps | Toggle absolute (HH:MM:SS) or relative (elapsed) |
| Auto-scroll | Follows new output, pauses when user scrolls up |
| Clear | Clear button or `Ctrl+L` |
| Export | Save to `.log` file |
| Baud rate | Auto-detected per chip, manual override available |
| Hex view | Toggle raw hex display |
| Line count | Shows total lines received |

#### Serial Plotter

Toggle between text and graph view (`Ctrl+Shift+P`):

- Parses lines matching `key:value` or `key=value` patterns
- Multiple channels with auto-assigned colors
- Y-axis auto-scales
- X-axis shows time
- Zoom with scroll wheel
- Pan by dragging
- Hover shows exact value at cursor
- Export as CSV or PNG

---

### 5. Project Management

#### New Project Wizard

Dialog with:
- Project name input
- Auto-detected chip (from connected device)
- Template selector:
  - **Blink** — single LED toggle
  - **IoT Sensor** — WiFi + MQTT + sensor reading
  - **State Machine** — LED states with transitions
  - **Motor Controller** — PID loop with safety
  - **Empty** — just `chip` and `main {}`
- WiFi credentials (saved globally, pre-filled)
- MQTT broker (saved globally, pre-filled)

Projects created in `~/Volt/` by default.

#### Recent Projects

Launch screen when no project is open:

```
⚡ Volt IDE

Recent Projects:
  📁 my-sensor       ESP32     2 hours ago
  📁 door-lock       RP2040    yesterday
  📁 greenhouse      ESP32     3 days ago

  [+ New Project]    [Open Folder]
```

#### Project Structure

```
~/Volt/my-sensor/
├── main.volt        ← source code
├── volt.toml        ← project config (chip, WiFi, MQTT)
├── build/           ← generated C + binary (gitignored)
└── .volt/           ← project cache (gitignored)
```

Single-file projects. One `main.volt`. No multi-file splitting needed for 99% of embedded projects. If a project grows, support `import` later.

---

### 6. Device Panel

#### Auto-Detection

Uses USB VID/PID for instant detection (no serial probing):

| VID | Chip | Detection speed |
|-----|------|----------------|
| `0x2E8A` | RP2040 | Instant |
| `0x0483` | STM32 | Instant |
| `0x303A` | ESP32-S2/S3 | Instant |
| `0x10C4` | CP2102 → esptool | 3 seconds |
| `0x1A86` | CH340 → esptool | 3 seconds |

#### Device Card

```
● ESP32                           /dev/ttyUSB1
  Connected • WiFi: NharirireFire • Heap: 280KB
```

- Green dot = connected and responsive
- Yellow dot = connected but not identified
- Red dot = was connected, now disconnected
- Live stats during monitoring (WiFi, heap, uptime)

#### Multi-Device

When multiple devices are connected:
- Each gets its own device card
- Active device (matching project chip) is highlighted
- Click a device to set it as target
- Can monitor multiple devices simultaneously (tabbed monitor)

---

### 7. Error Experience

Errors appear **in the code**, not in a separate panel.

#### Inline Errors

```volt
  4 │  hardware {
  5 │      pin led: Output = 6
    │                        ~~~
    │  ⚠ GPIO 6 is connected to SPI flash — using it will crash.
    │    Available: 2, 4, 5, 12-19, 21-23, 25-27, 32-33
  6 │  }
```

- Red underline on the error token
- Hover shows full error message + hint
- Gutter icon (red circle for error, yellow triangle for warning)
- Click gutter icon → shows quick fix menu

#### Error Panel

Collapsible panel listing all errors:

```
PROBLEMS (2 errors, 1 warning)

  ✗ line 5: GPIO 6 is connected to SPI flash
  ✗ line 12: Type mismatch: expected int, got string
  ⚠ line 8: GPIO 0 is a strapping pin
```

Click any error → editor jumps to that line.

#### Build Errors

If the C build fails (rare — the Volt compiler catches most errors):
- Parse the GCC/Clang error output
- Map back to `.volt` source line via `#line` directives
- Show as inline error in the Volt editor

---

### 8. Crash Decoder

When the device crashes and prints a backtrace over serial:

```
Guru Meditation Error: Core 0 panic'ed (LoadProhibited)
Backtrace: 0x400d1234:0x3ffb5e00 0x400d5678:0x3ffb5e20
```

The IDE:

1. Detects the backtrace pattern in serial output
2. Parses the addresses
3. Runs `xtensa-esp32-elf-addr2line` (or `arm-none-eabi-addr2line` for RP2040/STM32)
4. Maps C addresses back to `.volt` source lines via `#line` directives
5. Shows decoded crash in a panel:

```
CRASH DECODED — LoadProhibited on Core 0

  → main.volt:14  in sensor_poll()
    let val = sensor.read()    ← NULL pointer access
    
  Call stack:
    1. app_main()           main.volt:22
    2. volt_run()           (framework)
    3. sensor_poll_run()    main.volt:14  ← CRASH
```

6. Highlights the crashing line in the editor with a red background
7. Suggests fix: "sensor pin may not be configured — check hardware block"

---

### 9. Keyboard Shortcuts

| Action | Shortcut | Description |
|--------|----------|-------------|
| Build | `Ctrl+B` | Compile and build |
| Flash | `Ctrl+Shift+F` | Flash to connected device |
| Monitor | `Ctrl+M` | Toggle serial monitor |
| New project | `Ctrl+N` | Open new project wizard |
| Open project | `Ctrl+O` | Open existing project |
| Save | `Ctrl+S` | Save (+ format if enabled) |
| Format | `Ctrl+Shift+I` | Format code |
| Find | `Ctrl+F` | Find in editor |
| Replace | `Ctrl+H` | Find and replace |
| Go to line | `Ctrl+G` | Jump to line number |
| Next error | `F8` | Jump to next error |
| Previous error | `Shift+F8` | Jump to previous error |
| Toggle pin map | `Ctrl+P` | Show/hide pin diagram |
| Toggle plotter | `Ctrl+Shift+P` | Switch monitor text/graph |
| Command palette | `Ctrl+Shift+K` | Search all commands |
| Toggle sidebar | `Ctrl+\` | Show/hide sidebar |
| Increase font | `Ctrl+=` | Zoom in |
| Decrease font | `Ctrl+-` | Zoom out |

---

### 10. Settings

Minimal — the IDE should work without configuration.

```toml
# ~/.volt/ide-config.toml

[editor]
font_size = 14
font_family = "JetBrains Mono"
theme = "dark"             # dark, light
format_on_save = true
tab_size = 4

[serial]
default_baud = 115200
auto_detect_baud = true
show_timestamps = true
max_lines = 10000          # circular buffer

[projects]
folder = "~/Volt"

[wifi]
# Saved globally — pre-filled in new project wizard
ssid = "NharirireFire"
password = "Zimbabwe#1"

[mqtt]
broker = "mqtt://192.168.1.141"
```

---

### 11. Theming

Two built-in themes: dark (default) and light.

**Dark theme** — inspired by VS Code Dark+:
- Background: `#1e1e1e`
- Editor: `#252526`
- Sidebar: `#2d2d2d`
- Accent: `#4ec9b0` (Volt teal)
- Error: `#f44747`
- Warning: `#cca700`

**Light theme:**
- Background: `#ffffff`
- Editor: `#f5f5f5`
- Sidebar: `#e8e8e8`
- Accent: `#2b7cb3` (Volt blue)

Custom themes via CSS override file (advanced users only).

---

## Build Phases

### Phase 1 — Editor Shell (Week 1)

**Goal:** A window opens with a code editor that highlights Volt syntax.

- Tauri v2 project scaffold
- CodeMirror 6 integration with custom Volt syntax grammar
- File open/save
- Basic theme (dark)
- Window title shows filename

**Deliverable:** `volt-ide` binary that opens `.volt` files with syntax highlighting.

### Phase 2 — Sidebar + Devices (Week 2)

**Goal:** Sidebar shows connected devices and project info.

- Sidebar layout (devices, buttons, project info)
- USB device detection from Rust backend (`serialport` crate)
- Chip identification via VID/PID
- Device cards with chip name and port
- Build/Flash/Monitor buttons (visual only — wired in Phase 3)

**Deliverable:** IDE detects plugged-in boards and shows them in sidebar.

### Phase 3 — Build + Flash (Week 3)

**Goal:** One-click build and flash from the IDE.

- Build button calls `volt build` via Rust process spawning
- Build output captured and shown in status bar
- Flash button calls appropriate tool (esptool/picotool/UF2)
- Progress bar during flash
- Error output parsed and shown in editor
- Chip-to-port matching (project chip vs connected device)

**Deliverable:** Write code → click Build → click Flash → running on board.

### Phase 4 — Serial Monitor (Week 4)

**Goal:** Live serial output at the bottom of the IDE.

- Rust `serialport` crate reads serial data
- Streams to frontend via Tauri events
- Color-coded log levels
- Auto-detect baud rate
- Scroll, pause, clear, search
- Filter by tag
- Export to file

**Deliverable:** Full serial monitor with color coding and filtering.

### Phase 5 — LSP Integration (Weeks 5-6)

**Goal:** Autocomplete, hover info, and real-time error checking.

- Rust LSP client connects to existing `volt_lsp.py` server
- Autocomplete popups in CodeMirror
- Hover tooltips with pin info, function docs
- Real-time diagnostics (red/yellow squiggles)
- Go to definition
- Find references
- Quick fixes

**Deliverable:** Full IntelliSense — the editor knows Volt deeply.

### Phase 6 — Pin Map (Week 7)

**Goal:** Interactive chip pinout diagram in sidebar.

- SVG templates for each chip (ESP32, ESP8266, RP2040, STM32)
- Highlights used pins from code
- Color coding (used/blocked/warning/available)
- Click pin to insert in code
- Updates live as code changes

**Deliverable:** Visual pin map that syncs with your code.

### Phase 7 — Error Experience (Week 8)

**Goal:** Errors appear inline in the code, not in a log.

- Inline error decorations in CodeMirror
- Gutter icons (error/warning)
- Error panel with click-to-navigate
- Build error mapping (C line → Volt line via `#line`)
- Quick fix suggestions

**Deliverable:** Error experience that matches the best modern editors.

### Phase 8 — Project Wizard (Week 9)

**Goal:** New project dialog with templates and auto-detection.

- Modal dialog for new project
- Template selector with previews
- Auto-fill chip from connected device
- WiFi/MQTT credential management
- Recent projects on launch screen
- Project open/close

**Deliverable:** Complete project management from the IDE.

### Phase 9 — Serial Plotter (Week 10)

**Goal:** Graph numeric serial data live.

- Canvas 2D rendering
- Parse `key:value` patterns from serial
- Multi-channel with colors
- Auto-scaling Y axis
- Zoom and pan
- Hover for exact values
- Export CSV/PNG

**Deliverable:** Arduino-style serial plotter, but better.

### Phase 10 — State Machine Visualizer (Week 11)

**Goal:** See your state machines as diagrams.

- Parse `machine { }` blocks from AST
- Generate SVG: states as nodes, transitions as edges
- Show event names and guards on edges
- Highlight current state during monitoring
- Click node → jump to code
- Update live as code changes

**Deliverable:** State machines visible as diagrams, synced with code.

### Phase 11 — Crash Decoder (Week 12)

**Goal:** Decode crash backtraces to source lines.

- Detect backtrace patterns in serial output
- Run addr2line on addresses
- Map C lines back to Volt lines
- Show decoded stack in panel
- Highlight crash line in editor
- Works for ESP32 (xtensa) and RP2040/STM32 (ARM)

**Deliverable:** Crash → source line mapping, automatically.

### Phase 12 — Polish + Packaging (Weeks 13-14)

**Goal:** Ship-ready application.

- Light theme
- Settings dialog
- Keyboard shortcut customization
- Installer for Linux (.deb, .AppImage)
- Installer for macOS (.dmg)
- Installer for Windows (.msi)
- Auto-update mechanism
- Landing page: "Download Volt IDE"
- Documentation

**Deliverable:** Downloadable application for all platforms.

---

## File Structure

```
volt-ide/
├── src-tauri/              Rust backend
│   ├── src/
│   │   ├── main.rs         Tauri entry point
│   │   ├── serial.rs       Serial port management
│   │   ├── devices.rs      USB device detection
│   │   ├── build.rs        Build/flash orchestration
│   │   ├── lsp.rs          LSP client
│   │   ├── projects.rs     Project management
│   │   └── crash.rs        Crash decoder
│   ├── Cargo.toml
│   └── tauri.conf.json     Tauri configuration
├── src/                    Frontend
│   ├── index.html          Main HTML
│   ├── styles/
│   │   ├── main.css        Layout
│   │   ├── editor.css      CodeMirror theme
│   │   ├── sidebar.css     Sidebar components
│   │   └── monitor.css     Serial monitor
│   ├── js/
│   │   ├── app.js          Main application
│   │   ├── editor.js       CodeMirror setup + Volt mode
│   │   ├── sidebar.js      Sidebar UI
│   │   ├── monitor.js      Serial monitor UI
│   │   ├── plotter.js      Serial plotter
│   │   ├── pinmap.js       Pin map renderer
│   │   ├── statemachine.js State machine visualizer
│   │   └── ipc.js          Tauri IPC wrapper
│   └── assets/
│       ├── logo.svg
│       ├── pinmaps/        Per-chip SVG templates
│       └── fonts/
├── package.json            Frontend dependencies
└── README.md
```

---

## IPC Protocol

Frontend ↔ Backend communication via Tauri commands:

### Backend → Frontend (Events)

| Event | Payload | Description |
|-------|---------|-------------|
| `serial:data` | `{ port, line }` | Serial data received |
| `serial:connected` | `{ port, baud }` | Monitor started |
| `serial:disconnected` | `{ port }` | Monitor stopped |
| `device:added` | `{ port, chip, desc }` | USB device plugged in |
| `device:removed` | `{ port }` | USB device unplugged |
| `build:progress` | `{ stage, pct }` | Build progress update |
| `build:complete` | `{ success, time, size }` | Build finished |
| `build:error` | `{ line, col, msg, hint }` | Build error |
| `flash:progress` | `{ pct }` | Flash progress |
| `flash:complete` | `{ success }` | Flash finished |
| `lsp:diagnostics` | `{ uri, diagnostics[] }` | LSP diagnostics |
| `lsp:completion` | `{ items[] }` | Completion suggestions |
| `lsp:hover` | `{ contents }` | Hover information |

### Frontend → Backend (Commands)

| Command | Args | Description |
|---------|------|-------------|
| `open_file` | `{ path }` | Open a file |
| `save_file` | `{ path, content }` | Save a file |
| `build` | `{ project_path }` | Start build |
| `flash` | `{ project_path, port }` | Flash to device |
| `monitor_start` | `{ port, baud }` | Start serial monitor |
| `monitor_stop` | `{ port }` | Stop serial monitor |
| `scan_devices` | `{}` | Scan for USB devices |
| `new_project` | `{ name, chip, template }` | Create new project |
| `list_projects` | `{}` | List recent projects |
| `lsp_completion` | `{ uri, line, col }` | Request completions |
| `lsp_hover` | `{ uri, line, col }` | Request hover info |
| `format_code` | `{ content }` | Format Volt code |
| `decode_crash` | `{ backtrace, elf_path }` | Decode crash trace |

---

## Dependencies

### Rust (Backend)

```toml
[dependencies]
tauri = { version = "2", features = ["shell-open"] }
serialport = "4"           # Serial port I/O
serde = { version = "1", features = ["derive"] }
serde_json = "1"
tokio = { version = "1", features = ["full"] }
lsp-types = "0.95"         # LSP protocol types
udev = "0.8"               # Linux USB detection
object = "0.36"            # ELF parser for crash decode
addr2line = "0.24"         # Address to source line mapping
toml = "0.8"               # Config file parsing
```

### Frontend (npm)

```json
{
  "dependencies": {
    "@codemirror/state": "^6",
    "@codemirror/view": "^6",
    "@codemirror/language": "^6",
    "@codemirror/autocomplete": "^6",
    "@codemirror/lint": "^6",
    "@codemirror/search": "^6",
    "@lezer/lr": "^1",
    "@tauri-apps/api": "^2"
  }
}
```

---

## What Makes Volt IDE Groundbreaking

1. **15MB download** — smaller than a photo. Arduino IDE is 300MB.
2. **<1 second startup** — no Chromium to load.
3. **Pin map synced to code** — no other IDE does this.
4. **State machine diagrams from code** — not a drawing tool.
5. **Crash decoder built in** — backtrace → source line, instantly.
6. **Chip-aware autocomplete** — suggests valid pins, warns about conflicts.
7. **Zero configuration** — plug in, write code, flash. Done.
8. **50MB RAM** — runs on a Raspberry Pi. Arduino IDE needs 400MB.
9. **Three-click workflow** — open, plug in, flash. No terminal needed.
10. **Built for one language** — every feature serves Volt. No bloat.
