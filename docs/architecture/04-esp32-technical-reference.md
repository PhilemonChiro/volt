# ESP32-WROOM-32 DevKit V1: Complete Technical Reference

## For Firmware Development From Scratch

---

## 1. Chip Overview

- **SoC:** ESP32 (ESP32-D0WDQ6 in WROOM-32 module)
- **Architecture:** Dual-core Xtensa LX6, 32-bit, 7-stage pipeline
- **Clock:** 240 MHz max (configurable: 80/160/240 MHz from PLL)
- **FPU:** Single-precision floating point
- **Performance:** 600 DMIPS (dual-core @ 240 MHz)
- **Package:** QFN 6x6mm (48 pins), module 18x25.5mm
- **Supply:** 3.0-3.6V, minimum 500mA capable supply
- **Temperature:** -40 to +85 deg C

---

## 2. Memory Architecture

### 2.1 Internal SRAM (520 KB total)

| Block | Size | Address Range | Usage |
|-------|------|---------------|-------|
| SRAM0 | 192 KB | `0x40070000 - 0x4009FFFF` | IRAM (instruction) |
| SRAM1 | 128 KB | `0x3FFE0000 - 0x3FFFFFFF` (data) / `0x400A0000 - 0x400BFFFF` (instr) | Shared IRAM/DRAM |
| SRAM2 | 200 KB | `0x3FFAE000 - 0x3FFDFFFF` | DRAM (data) |

### 2.2 IRAM (Instruction RAM)

- **Usable:** ~128 KB after 64 KB cache reservation
- **Address:** `0x40080000` to `0x400A0000`
- **CPU0 cache:** `0x40070000 - 0x40077FFF` (32 KB, reserved)
- **CPU1 cache:** `0x40078000 - 0x4007FFFF` (32 KB, released to heap in single-core mode)
- **Access:** 4-byte aligned only. Unaligned = exception (~167 cycle penalty with ESP-IDF handler)
- **Placement:** Use `IRAM_ATTR` macro
- **Unused IRAM after .text** is added to heap as `MALLOC_CAP_EXEC`

### 2.3 DRAM (Data RAM)

- **Total available:** ~328 KB
- **Typical heap regions after boot:**
  - `0x3FFAE6E0` — 6 KB (DRAM)
  - `0x3FFB2EC8` — 180 KB (DRAM, main heap)
  - `0x3FFE0440` — 14 KB (D/IRAM)
  - `0x3FFE4350` — 111 KB (D/IRAM)
- **ROM reserved:** `0x3FFAE000-0x3FFAFFFF` (8 KB), scattered 1KB regions
- **With Bluetooth:** 54 KB reserved at `0x3FFB0000-0x3FFBDB5C` (BLE-only recovers ~19 KB)
- **With WiFi active:** ~60-80 KB consumed by WiFi stack
- **Realistic free heap (WiFi + BLE):** 100-130 KB

### 2.4 Flash Mapping (XIP — Execute In Place)

- **External flash:** 4 MB on WROOM-32 module (up to 16 MB addressable)
- **IROM (code):** Mapped via MMU cache, code executes directly from flash
- **DROM (const data):** Read-only data mapped via cache
- **Cache:** 32 KB per CPU, two-way set-associative, 32-byte blocks
- **Cache disabled during flash writes** — any ISR code must be in IRAM

### 2.5 RTC Memory (survives deep sleep)

| Region | Size | Address | Usage |
|--------|------|---------|-------|
| RTC FAST | 8 KB | `0x3FF80000` (data) / `0x400C0000` (code) | Wake stub, main CPU accessible |
| RTC SLOW | 8 KB | `0x50000000` | ULP coprocessor programs/data |

- `RTC_NOINIT_ATTR` — values survive deep sleep and software reset
- `RTC_DATA_ATTR` — place in RTC FAST memory
- NOT DMA-capable

### 2.6 Heap Capability Flags

```c
MALLOC_CAP_8BIT      // Byte-addressable (DRAM)
MALLOC_CAP_32BIT     // 32-bit aligned only (includes IRAM)
MALLOC_CAP_DMA       // DMA-capable (internal DRAM only, word-aligned)
MALLOC_CAP_EXEC      // Executable (IRAM)
MALLOC_CAP_INTERNAL  // Internal RAM (survives cache ops)
MALLOC_CAP_SPIRAM    // External SPI RAM (PSRAM)
MALLOC_CAP_DEFAULT   // Standard malloc compatibility
MALLOC_CAP_RTCRAM    // RTC fast memory

// Usage:
void *buf = heap_caps_malloc(1024, MALLOC_CAP_DMA);
size_t free = heap_caps_get_free_size(MALLOC_CAP_8BIT);
```

---

## 3. Boot Process (Power-On to app_main)

### Stage 1: ROM Bootloader (burned into silicon, immutable)

1. PRO_CPU (CPU0) starts at reset vector in ROM. APP_CPU (CPU1) held in reset.
2. Reads strapping pins from `GPIO_STRAP_REG`:
   - **GPIO0** low at reset = UART download mode
   - **GPIO0** high (or floating w/ pull-up) = normal SPI flash boot
   - **GPIO2** must be low for download mode
   - **GPIO12** selects VDD_SDIO voltage (low=3.3V, high=1.8V)
3. Deep-sleep resume: checks `RTC_CNTL_STORE6_REG` for valid entry point + CRC in `RTC_CNTL_STORE7_REG`. If valid, jumps directly.
4. Configures SPI flash from eFuse values.
5. Loads second-stage bootloader from flash offset `0x1000`.
6. RTC watchdog active (auto-reset if boot stalls).

### Stage 2: ESP-IDF Bootloader (flash offset 0x1000)

1. Reads partition table from flash offset `0x8000`.
2. Finds factory/OTA app partition. If OTA exists, consults `otadata` partition.
3. Loads binary image segment by segment:
   - IRAM/DRAM segments: copied from flash to RAM
   - DROM/IROM segments: flash MMU configured for mapping (no copy)
4. Verifies image integrity.
5. Jumps to application entry point.

**Size limit:** 32 KB default (48 KB max with Secure Boot V2).

### Stage 3: Application Startup

**Phase 3a** — `call_start_cpu0()` (`components/esp_system/port/cpu_start.c`):
1. Reconfigure CPU exception handlers
2. Disable RTC watchdog
3. Initialize .data and zero .bss
4. Complete MMU cache configuration
5. Enable PSRAM (if configured)
6. Set CPU clock frequency
7. Start APP_CPU (set entry, de-assert reset, wait for flag)

**Phase 3b** — `start_cpu0()` (`components/esp_system/startup.c`):
1. Log app info (project name, IDF version)
2. Initialize heap allocator (multi-heap, capability-based)
3. Initialize libc / time
4. Configure brownout detector
5. Set up stdin/stdout/stderr
6. Security checks, eFuse burning
7. Initialize SPI flash API
8. Call C++ constructors and `__attribute__((constructor))` functions
9. Execute `ESP_SYSTEM_INIT_FN` callbacks in priority order

**Phase 3c** — FreeRTOS:
1. Create `main_task` (priority 1, stack from `CONFIG_ESP_MAIN_TASK_STACK_SIZE`, default 3584 bytes)
2. Start FreeRTOS scheduler
3. `app_main()` called — **this is your entry point**
4. If `app_main()` returns, task is cleaned up; other tasks continue

### Flash Layout

| Offset | Content |
|--------|---------|
| `0x0000` | (Secure boot IV/digest if enabled) |
| `0x1000` | Second-stage bootloader |
| `0x8000` | Partition table |
| `0x9000` | NVS partition |
| `0xF000` | PHY init data |
| `0x10000` | Application binary |

### Partition Table (factory + dual OTA)

```
nvs,      data, nvs,     0x9000,  0x4000
otadata,  data, ota,     0xd000,  0x2000
phy_init, data, phy,     0xf000,  0x1000
factory,  app,  factory, 0x10000, 1M
ota_0,    app,  ota_0,   0x110000, 1M
ota_1,    app,  ota_1,   0x210000, 1M
```

---

## 4. CPU Architecture (Xtensa LX6)

### 4.1 Register File

- **64 physical registers** (32-bit each)
- **16 visible** at any time (a0-a15) via windowed register mechanism
- `a0` = return address, `a1` = stack pointer, `a2-a7` = first 6 arguments
- **WINDOWBASE** (4-bit): current window position. Rotates by 1/2/3 groups on `CALL4/8/12`
- Window overflow/underflow exceptions handle spilling to stack

### 4.2 Special Registers

| Register | Purpose |
|----------|---------|
| PC | Program Counter |
| PS | Processor State (interrupt level, window state, exception mode) |
| SAR | Shift Amount Register |
| LBEG, LEND, LCOUNT | Zero-overhead loop control |
| EPC1-EPC6 | Exception PC per interrupt level |
| EXCCAUSE | Exception cause code |
| EXCVADDR | Exception virtual address |
| CCOUNT | Cycle counter |
| CCOMPARE0-2 | Timer compare (generates interrupt when CCOUNT matches) |

### 4.3 Dual-Core Operation

- **CPU0 (PRO_CPU):** Protocol CPU — handles WiFi/BT by default
- **CPU1 (APP_CPU):** Application CPU — runs user tasks
- Both share same address space (SRAM, peripherals, flash)
- Cross-core communication via cross-core interrupts + shared memory
- `portENTER_CRITICAL()` disables interrupts AND acquires spinlock (both cores)

### 4.4 Interrupt Architecture

- **32 interrupt inputs per core**, 26 usable for peripherals
- **Priority levels 1-7** (7 = NMI)
- User handlers attachable to levels 1-3 only (4+ requires raw assembly)
- Interrupt matrix routes peripheral sources to CPU interrupt slots
- Allocation binds to calling core; deallocation must happen on same core

```c
// Allocate interrupt
esp_intr_alloc(ETS_GPIO_INTR_SOURCE, ESP_INTR_FLAG_LEVEL1,
               gpio_isr_handler, arg, &handle);

// IRAM-safe ISR (required if flash operations possible)
void IRAM_ATTR gpio_isr_handler(void *arg) {
    // All code in IRAM, all data in DRAM, no flash access
}
```

### 4.5 Context Switching on Xtensa

1. Timer tick or yield triggers level-1 software interrupt
2. Handler spills ALL register windows to stack (walk WINDOWSTART bitmap)
3. Save PC, PS, SAR, loop registers, exception registers
4. Save stack pointer to current TCB
5. Scheduler selects next task
6. Restore new task's stack pointer, WINDOWBASE, WINDOWSTART
7. Restore special registers
8. `RFE` (Return From Exception) → new task resumes

The windowed ABI makes this more complex than typical RISC context switches. ~500 cycles typical.

---

## 5. Peripheral Inventory & Register Map

### 5.1 Complete Peripheral Base Addresses

```c
// System
DR_REG_DPORT_BASE         0x3FF00000   // System/DPort registers
DR_REG_RTCCNTL_BASE       0x3FF48000   // RTC control
DR_REG_RTCIO_BASE         0x3FF48400   // RTC GPIO
DR_REG_IO_MUX_BASE        0x3FF49000   // IO MUX

// GPIO
DR_REG_GPIO_BASE          0x3FF44000   // GPIO matrix

// Communication
DR_REG_UART_BASE          0x3FF40000   // UART0
DR_REG_UART1_BASE         0x3FF50000   // UART1
DR_REG_UART2_BASE         0x3FF6E000   // UART2
DR_REG_I2C_EXT_BASE       0x3FF53000   // I2C0
DR_REG_I2C1_EXT_BASE      0x3FF67000   // I2C1
DR_REG_SPI2_BASE          0x3FF64000   // SPI2 (HSPI)
DR_REG_SPI3_BASE          0x3FF65000   // SPI3 (VSPI)
DR_REG_I2S_BASE           0x3FF4F000   // I2S0
DR_REG_I2S1_BASE          0x3FF6D000   // I2S1

// Timers
DR_REG_TIMERGROUP0_BASE   0x3FF5F000   // Timer Group 0
DR_REG_TIMERGROUP1_BASE   0x3FF60000   // Timer Group 1

// PWM
DR_REG_LEDC_BASE          0x3FF59000   // LED PWM (16 channels)
DR_REG_PWM_BASE           0x3FF5E000   // Motor PWM 0
DR_REG_PWM1_BASE          0x3FF6C000   // Motor PWM 1

// Other
DR_REG_RMT_BASE           0x3FF56000   // Remote Control (IR, WS2812)
DR_REG_PCNT_BASE          0x3FF57000   // Pulse Counter
DR_REG_SENS_BASE          0x3FF48800   // ADC / Touch / Temperature
DR_REG_SDMMC_BASE         0x3FF68000   // SD/MMC host
DR_REG_EMAC_BASE          0x3FF69000   // Ethernet MAC

// Crypto
DR_REG_RSA_BASE           0x3FF02000   // RSA accelerator
DR_REG_SHA_BASE           0x3FF03000   // SHA accelerator
DR_REG_EFUSE_BASE         0x3FF5A000   // eFuse controller
```

### 5.2 GPIO Matrix and IO_MUX

**Two-layer routing system:**

1. **IO_MUX** (direct path, fastest): Each pad has 3-4 hardwired functions. Function 0 = "GPIO" (connects to GPIO Matrix).
2. **GPIO Matrix** (flexible crossbar): Any GPIO → any peripheral signal, and vice versa.

**Key GPIO registers** (base `0x3FF44000`):
```c
GPIO_OUT_REG       (0x3FF44004)  // Output level GPIO 0-31
GPIO_OUT_W1TS_REG  (0x3FF44008)  // Set bits (write 1 to set)
GPIO_OUT_W1TC_REG  (0x3FF4400C)  // Clear bits (write 1 to clear)
GPIO_ENABLE_REG    (0x3FF44020)  // Output enable GPIO 0-31
GPIO_IN_REG        (0x3FF4403C)  // Input level GPIO 0-31
GPIO_STATUS_REG    (0x3FF44044)  // Interrupt status
GPIO_PINn_REG      (0x3FF44088 + n*4)  // Per-pin config
```

### 5.3 Peripheral Summary

| Peripheral | Count | Key Specs |
|-----------|-------|-----------|
| GPIO | 34 pins | 6 input-only (GPIO34-39), GPIO matrix for flexible routing |
| UART | 3 | Up to 5 Mbps, 128-byte FIFOs, DMA |
| SPI | 2 usable (HSPI, VSPI) | SPI0/1 reserved for flash. Up to 80 MHz (IO_MUX) / 26.6 MHz (GPIO matrix) |
| I2C | 2 | 100/400 kHz standard, 32-byte FIFOs |
| I2S | 2 | Full/half duplex, PDM, DMA |
| ADC | 2x 12-bit SAR | 18 channels. **ADC2 blocked when WiFi active** |
| DAC | 2x 8-bit | GPIO25, GPIO26 |
| Touch | 10 | Capacitive sensing on specific GPIOs |
| LED PWM | 16 channels | 20-bit resolution, 8 timers |
| Motor PWM | 6 outputs | Dead time, fault detection |
| RMT | 8 channels | IR, WS2812 LEDs, custom protocols |
| Pulse Counter | 8 units | 16-bit signed, glitch filter |
| Timers | 4x 64-bit | 16-bit prescaler, auto-reload, alarm |
| Watchdogs | 3 | 2 MWDT + 1 RWDT |
| TWAI (CAN) | 1 | ISO 11898-1, up to 1 Mbit/s |
| Ethernet MAC | 1 | 10/100 Mbps MII/RMII |
| Crypto | AES, SHA, RSA, RNG | Hardware accelerated |

---

## 6. DevKit V1 Pin Map

### Pins You Can Safely Use

| GPIO | Location | ADC | Touch | I2C Default | SPI Default | Notes |
|------|----------|-----|-------|-------------|-------------|-------|
| 2 | J3 | ADC2_CH2 | T2 | | | On-board LED on most DevKits. Strapping pin. |
| 4 | J3 | ADC2_CH0 | T0 | | | General purpose |
| 5 | J3 | | | | VSPI_CS0 | Strapping pin. Outputs PWM at boot. |
| 13 | J2 | ADC2_CH4 | T4 | | HSPI_MOSI | General purpose |
| 14 | J2 | ADC2_CH6 | T6 | | HSPI_CLK | General purpose |
| 15 | J2 | ADC2_CH3 | T3 | | HSPI_CS0 | Strapping pin. Outputs PWM at boot. |
| 16 | J3 | | | | | Free on WROOM-32 (PSRAM on WROVER) |
| 17 | J3 | | | | | Free on WROOM-32 (PSRAM on WROVER) |
| 18 | J3 | | | | VSPI_CLK | General purpose |
| 19 | J3 | | | | VSPI_MISO | General purpose |
| 21 | J3 | | | I2C_SDA | | General purpose |
| 22 | J3 | | | I2C_SCL | | General purpose |
| 23 | J3 | | | | VSPI_MOSI | General purpose |
| 25 | J2 | ADC2_CH8 | | | | DAC_1 |
| 26 | J2 | ADC2_CH9 | | | | DAC_2 |
| 27 | J2 | ADC2_CH7 | T7 | | | General purpose |
| 32 | J2 | ADC1_CH4 | T9 | | | XTAL_32K_P (if 32K crystal used) |
| 33 | J2 | ADC1_CH5 | T8 | | | XTAL_32K_N (if 32K crystal used) |

### Input-Only Pins (no output, no pull-up/down)

| GPIO | ADC | Notes |
|------|-----|-------|
| 34 | ADC1_CH6 | Input only |
| 35 | ADC1_CH7 | Input only |
| 36 (VP) | ADC1_CH0 | Input only. Interrupt glitch with ADC+WiFi sleep |
| 39 (VN) | ADC1_CH3 | Input only. Interrupt glitch with ADC+WiFi sleep |

### DO NOT USE

| GPIO | Reason |
|------|--------|
| 6, 7, 8, 9, 10, 11 | Connected to SPI flash |
| 1 (TX) | UART0 TX (serial console) |
| 3 (RX) | UART0 RX (serial console) |

### Strapping Pins (affect boot behavior)

| GPIO | Boot Function | Safe Default |
|------|--------------|-------------|
| 0 | Boot mode: HIGH=flash, LOW=download | Pull-up (has internal pull-up) |
| 2 | Must be LOW or floating for download | Leave floating |
| 5 | SDIO timing | Pull-up (boot msg on UART) |
| 12 | VDD_SDIO voltage: LOW=3.3V, HIGH=1.8V | **Must be LOW** for 3.3V flash |
| 15 | SDIO timing, UART boot message | Pull-up |

---

## 7. Power Modes

| Mode | What's ON | Current | Wake Latency |
|------|-----------|---------|-------------|
| **Active (WiFi TX)** | Everything | 95-240 mA | N/A |
| **Modem Sleep @80MHz** | CPU, RAM, peripherals | 20-25 mA | Negligible |
| **Modem Sleep @240MHz** | CPU, RAM, peripherals | 30-50 mA | Negligible |
| **Light Sleep** | RTC, RTC mem, clock-gated CPU/RAM | ~0.8 mA | <1 ms |
| **Deep Sleep (timer)** | RTC controller, RTC memory | 6-10 uA | ~several ms |
| **Deep Sleep (ULP)** | RTC + ULP coprocessor | 10-150 uA | ~several ms |
| **Hibernation** | RTC timer only | ~5 uA | ~several ms |

### WiFi Power Save Modes

| Mode | Average Current | Description |
|------|----------------|-------------|
| Modem Sleep DTIM1 | 22.65 mA | WiFi wakes at every beacon |
| Modem Sleep DTIM3 | 21.89 mA | WiFi wakes every 3rd beacon |
| Modem Sleep DTIM10 | 20.01 mA | WiFi wakes every 10th beacon |
| Auto Light-sleep DTIM1 | 3.34 mA | CPU sleeps between beacons |
| Auto Light-sleep DTIM3 | 2.33 mA | Deepest WiFi-maintained sleep |
| Auto Light-sleep DTIM10 | 2.19 mA | Maximum WiFi power save |

### Wake-Up Sources

| Source | Deep Sleep | Light Sleep |
|--------|-----------|-------------|
| Timer | Yes | Yes |
| Touch pad | Yes | Yes |
| EXT0 (single RTC GPIO, level) | Yes | Yes |
| EXT1 (multiple RTC GPIOs) | Yes | Yes |
| GPIO (any pin) | No | Yes |
| UART (edge count) | No | Yes |
| ULP coprocessor | Yes | Yes |
| WiFi | No | Yes |

**RTC GPIOs** (usable as deep-sleep wake sources): GPIO 0, 2, 4, 12-15, 25-27, 32-39

### ULP Coprocessor

- FSM-based coprocessor in RTC domain, runs during deep sleep
- 4x 16-bit registers (R0-R3), 8-bit stage counter
- Instructions: ADC read, I2C read/write, GPIO read/write, register access, temperature sensor
- Runs from RTC SLOW memory (8 KB)
- Can wake main CPUs via `WAKE` instruction

---

## 8. WiFi Specifications

| Parameter | Value |
|-----------|-------|
| Standards | 802.11 b/g/n |
| Frequency | 2.4 GHz (2412-2484 MHz) |
| Max data rate | 150 Mbps (HT40) |
| TX power (11b) | up to 20.5 dBm |
| TX power (11n) | up to 18 dBm |
| RX sensitivity (11b 1Mbps) | -98 dBm |
| RX sensitivity (11n HT20 MCS7) | -73 dBm |
| Modes | STA, AP, STA+AP, promiscuous, sniffer |
| Virtual interfaces | 4 |
| Max AP clients | 10 |

### RF Current (3.3V, 25 deg C)

| Mode | Current |
|------|---------|
| TX 11b 1Mbps +19.5dBm | 240 mA |
| TX 11n MCS7 +14dBm | 180 mA |
| RX (all modes) | 95-100 mA |
| BT TX +0dBm | 130 mA |
| BT/BLE RX | 95-100 mA |

### WiFi Stack Memory Usage

- `esp_wifi_init()` consumes ~60-80 KB heap
- Static RX buffers: 10 x 1.6KB = 16 KB
- Dynamic RX buffers: up to 32
- Static TX buffers: 16 x 1.6KB = 25.6 KB
- **After WiFi init, expect ~100-130 KB free heap (no BT)**

---

## 9. Bluetooth Specifications

- **Standard:** Bluetooth v4.2 BR/EDR + BLE dual-mode
- **TX power:** +9 dBm max (8 configurable levels, -12 to +9 dBm)
- **BLE sensitivity:** -92 to -94 dBm
- **Memory cost:** 54 KB for classic BT, ~35 KB for BLE-only
- **Stack options:** Bluedroid (default) or NimBLE (lighter, BLE-only)

---

## 10. Clock System

### Clock Sources

| Source | Frequency | Notes |
|--------|-----------|-------|
| XTAL | 40 MHz | External crystal (required for WiFi/BT) |
| PLL | 320/480 MHz | From XTAL via PLL |
| RC_FAST | ~8.5 MHz | Internal RC, calibratable |
| RC_SLOW | ~150 kHz | Internal RC (RTC timer default) |
| XTAL32K | 32.768 kHz | Optional external crystal |

### CPU Clock Derivation

| CPU Freq | Source |
|----------|--------|
| 240 MHz | 480 MHz PLL / 2 |
| 160 MHz | 320 MHz PLL / 2 |
| 80 MHz | 320 MHz PLL / 4 |
| 40 MHz | XTAL direct |

### APB Clock

- 80 MHz when CPU uses PLL
- Equals XTAL frequency when CPU uses XTAL
- Used by most peripherals (UART, SPI, I2C, timers, PWM)

---

## 11. Critical Constraints Summary

1. **GPIO6-11:** Connected to SPI flash. Never reconfigure.
2. **GPIO16-17:** Reserved on WROVER (PSRAM). Free on WROOM-32.
3. **GPIO34-39:** Input-only. No pull-up/pull-down. No output.
4. **GPIO12:** Strapping pin. If HIGH at boot, VDD_SDIO=1.8V → boot failure with 3.3V flash.
5. **ADC2 vs WiFi:** All ADC2 channels BLOCKED when WiFi driver is active. Use ADC1 for sensor readings.
6. **GPIO36/39:** Interrupt disabled when ADC+WiFi/BT sleep enabled (hardware errata).
7. **DMA buffers:** Must be internal DRAM, 32-bit aligned, length multiple of 4 bytes.
8. **IRAM-safe ISRs:** All code in IRAM (`IRAM_ATTR`), all data in DRAM (`DRAM_ATTR`), zero flash access.
9. **SPI through GPIO matrix:** Max 26.6 MHz full-duplex. IO_MUX pins for 80 MHz.
10. **Interrupt allocation:** Must free on same core as allocated.
11. **Deep sleep:** ALL RAM lost except RTC memory (16 KB total).
12. **40 MHz crystal required** for WiFi/Bluetooth.
13. **500 mA minimum** power supply capability.
14. **Stack overflow = hard fault.** Default main task stack is only 3584 bytes.
15. **FreeRTOS critical sections** on dual-core = spinlock + interrupt disable on calling core.

---

## 12. ESP-IDF Key APIs We'll Wrap

### GPIO
```c
gpio_config_t cfg = { .pin_bit_mask = (1ULL << pin), .mode = GPIO_MODE_OUTPUT };
gpio_config(&cfg);
gpio_set_level(pin, 1);
gpio_get_level(pin);
gpio_install_isr_service(0);
gpio_isr_handler_add(pin, isr_fn, arg);
```

### I2C (New Driver API)
```c
i2c_master_bus_config_t bus_cfg = { .i2c_port = I2C_NUM_0, .sda_io_num = 21, .scl_io_num = 22 };
i2c_new_master_bus(&bus_cfg, &bus_handle);
i2c_device_config_t dev_cfg = { .device_address = 0x76, .scl_speed_hz = 400000 };
i2c_master_bus_add_device(bus_handle, &dev_cfg, &dev_handle);
i2c_master_transmit_receive(dev_handle, write_buf, write_len, read_buf, read_len, timeout_ms);
```

### SPI Master
```c
spi_bus_config_t bus = { .mosi_io_num=23, .miso_io_num=19, .sclk_io_num=18, .max_transfer_sz=4096 };
spi_bus_initialize(SPI2_HOST, &bus, SPI_DMA_CH_AUTO);
spi_device_interface_config_t dev = { .clock_speed_hz=1000000, .spics_io_num=5, .queue_size=7 };
spi_bus_add_device(SPI2_HOST, &dev, &handle);
spi_device_transmit(handle, &transaction);
```

### WiFi
```c
wifi_init_config_t cfg = WIFI_INIT_CONFIG_DEFAULT();
esp_wifi_init(&cfg);
esp_wifi_set_mode(WIFI_MODE_STA);
wifi_config_t wifi_cfg = { .sta = { .ssid = "MyNet", .password = "pass" } };
esp_wifi_set_config(WIFI_IF_STA, &wifi_cfg);
esp_wifi_start();
esp_wifi_connect();
```

### Sleep
```c
esp_sleep_enable_timer_wakeup(5000000);  // 5 seconds
esp_light_sleep_start();  // returns after wake

esp_sleep_enable_ext0_wakeup(GPIO_NUM_0, 0);  // wake on GPIO0 LOW
esp_deep_sleep_start();  // never returns
```

### NVS (Key-Value Storage)
```c
nvs_handle_t handle;
nvs_open("storage", NVS_READWRITE, &handle);
nvs_set_i32(handle, "counter", 42);
nvs_commit(handle);
int32_t val;
nvs_get_i32(handle, "counter", &val);
nvs_close(handle);
```

---

## Sources

- ESP32 Datasheet: https://www.espressif.com/sites/default/files/documentation/esp32_datasheet_en.pdf
- ESP32 Technical Reference Manual: https://www.espressif.com/sites/default/files/documentation/esp32_technical_reference_manual_en.pdf
- ESP32-WROOM-32 Datasheet: https://www.espressif.com/sites/default/files/documentation/esp32-wroom-32_datasheet_en.pdf
- ESP32-DevKitC User Guide: https://docs.espressif.com/projects/esp-dev-kits/en/latest/esp32/esp32-devkitc/user_guide.html
- ESP-IDF Programming Guide: https://docs.espressif.com/projects/esp-idf/en/stable/esp32/
- ESP-IDF Memory Types: https://docs.espressif.com/projects/esp-idf/en/stable/esp32/api-guides/memory-types.html
- ESP32 Memory Model: https://developer.espressif.com/blog/esp32-programmers-memory-model/
- ESP-IDF Startup Flow: https://docs.espressif.com/projects/esp-idf/en/stable/esp32/api-guides/startup.html
- ESP-IDF GPIO API: https://docs.espressif.com/projects/esp-idf/en/stable/esp32/api-reference/peripherals/gpio.html
- ESP-IDF I2C API: https://docs.espressif.com/projects/esp-idf/en/stable/esp32/api-reference/peripherals/i2c.html
- ESP-IDF SPI API: https://docs.espressif.com/projects/esp-idf/en/stable/esp32/api-reference/peripherals/spi_master.html
- ESP-IDF WiFi API: https://docs.espressif.com/projects/esp-idf/en/stable/esp32/api-reference/network/esp_wifi.html
- ESP-IDF Sleep Modes: https://docs.espressif.com/projects/esp-idf/en/stable/esp32/api-reference/system/sleep_modes.html
- ESP-IDF Build System: https://docs.espressif.com/projects/esp-idf/en/stable/esp32/api-guides/build-system.html
- Xtensa ISA: https://dl.espressif.com/github_assets/espressif/xtensa-isa-doc/releases/download/latest/Xtensa.pdf
