# Prebuilt ESP-IDF for `volt build` (design)

Status: design approved 2026-10-02; spike passed, including on-board run (see below).

## Why

Measured on an M2, darwin-arm64, fresh `HOME` (2026-10-02):

| | Volt today | Arduino-ESP32 |
|---|---|---|
| First build of a project (blink) | ~90 s | ~45–56 s |
| Repeat build | ~2 s | ~20 s |
| ESP32 toolchain download | ~800 MB (Python, CMake, Ninja, ESP-IDF source 233 MB, ESP-IDF tools 442 MB) | — |

The cabinet firmware's ESP-IDF build compiles **904 files; 13 are Volt's**
(`main.c`, the runtime, 4 drivers). The other 891 are ESP-IDF, identical for
every Volt project because every project uses the same fixed sdkconfig.
Compiling them per project is the whole first-build cost. (A shared ccache
does not fix this: measured 0 % hits for another user, 1.4 % for another
project path.)

## How Arduino does it (Arduino-ESP32 3.3.10, inspected locally)

One host-independent package per chip (`esp32-libs`, `esp32s3-libs`, …),
built by Espressif's lib-builder from ESP-IDF v5.5.4:

- `lib/` — 141 prebuilt component archives (113 MB)
- `include/` — headers (44 MB), `sdkconfig/` — the config they were built with
- `ld/` — generated linker scripts (`memory.ld`, `sections.ld`, ROM scripts)
- `flags/` — plain-text `defines`, `c_flags`, `includes`, `ld_flags`,
  `ld_libs`, `ld_scripts`
- `bin/` — bootloader ELFs per flash mode/frequency (`dio_40m`, `qio_80m`, …)

A sketch build compiles only the core + sketch with the `xtensa-esp-elf`
compiler and those flags, links against `lib/`, then a standalone `esptool`
binary (no Python install) does `elf2image`; `gen_esp32part` makes the
partition table. No CMake, Ninja, ESP-IDF source or Python environment.

## Design

### 1. The SDK pack (one per chip × ESP-IDF version × Volt profile)

`volt-sdk-esp32-idf5.4-<profile-hash>.tar.gz` — target code only, so **one
pack serves every host platform**:

```
include/            headers, paths rewritten relative to the pack
lib/*.a             every component archive the profile builds (not main)
ld/                 generated memory.ld, sections.ld + ROM/peripheral scripts
bootloader/         bootloader-{dio,qio}-{40m,80m}.bin (prebuilt, not ELF)
partitions/         default partition-table bins (per flash size)
sdkconfig, sdkconfig.h
build.json          defines, cflags, include order, ldflags, libs (order and
                    whole-archive groups), ld scripts, flash offsets
provenance.json     ESP-IDF commit, compiler version, profile, builder commit
```

Delivered like every other toolchain piece: a signed-manifest asset with
SHA-256, hosted on the GitHub release, installed to
`~/.volt/toolchains/sdk-esp32`.

### 2. The Volt profile (the fixed sdkconfig)

One sdkconfig per chip that enables everything Volt's runtime supports, so
any Volt program links against the same pack. `--gc-sections` drops unused
code, so blink does not grow. Reproducible-build options on
(`CONFIG_APP_REPRODUCIBLE_BUILD`, already `CONFIG_COMPILER_HIDE_PATHS_MACROS`)
so no builder paths leak into the archives.

Per-project settings move out of sdkconfig: flash size/mode/frequency are
image and flash-time arguments (`esptool elf2image --flash-size …`), and the
partition table is chosen per project. Anything that genuinely needs a
different sdkconfig uses the fallback (§5).

### 3. Producer: `volt sdk build <chip>` (maintainer/CI only)

Runs where full ESP-IDF is installed (today's toolchain). It builds a
reference project with the profile whose `main` requires every component the
runtime can use, then harvests from the build directory:

- `esp-idf/*/lib*.a` → `lib/`
- compile flags, defines and include dirs from `compile_commands.json` (the
  `main.c` entry)
- link line, library order and whole-archive groups from `build.ninja`
- generated `ld/` scripts, `sdkconfig.h`
- bootloader for each flash mode/frequency, partition tables

It then **verifies the pack** by building every example plus the cabinet
firmware with the pack and with the full IDF path and comparing: both must
link, and image sizes must match closely. CI (GitHub Actions) runs it per chip
and uploads the pack to the release.

### 4. Consumer: `volt build` with a pack

A Go build driver replaces CMake/Ninja for ESP32 projects:

1. Compile the ~13 Volt files (generated `main.c`, runtime, used drivers) in
   parallel with `xtensa-esp-elf-gcc` and the pack's flags. Objects are
   cached by content hash, giving incremental builds without Ninja.
2. Link with the pack's libraries and linker scripts → `<name>.elf`.
3. `esptool elf2image` → app `.bin`; copy the matching bootloader and
   partition table.
4. `volt flash` writes bootloader `0x1000`, partition table `0x8000`, app
   `0x10000` (what `idf.py flash` does today).

Same JSON progress events, so the IDE and VS Code need no change.

### 5. Fallback: the current ESP-IDF path

Kept, not deleted: `volt build --idf`, used when no pack matches the chip or
profile, and by the producer itself. It is installed on demand
(`volt toolchain install esp32 --idf`), not by default.

### 6. What the default ESP32 install becomes

| Kept | Dropped from the default install |
|---|---|
| `xtensa-esp-elf` compiler (trimmed to what ESP32 needs) | ESP-IDF source (233 MB download) |
| SDK pack (est. 40–60 MB compressed) | ESP-IDF Python environment |
| `esptool` standalone binary (official release, no Python) | Python, CMake, Ninja |

The compiler is now the bulk (1.0 GB unpacked, multilib for all Xtensa
chips); trimming it is a separate, measurable step. Porting `elf2image` and
the partition-table generator to Go is small and removes `esptool` from the
build step (flashing still uses it until the flasher is ported). That moves
ESP32 builds to pure Go plus the compiler.

## Expected result (to be measured, not promised)

First build: compile ~13 files + link + image, plausibly **5–15 s** for any
program, WiFi included. Repeat: ~1–2 s. Default download: roughly a third of
today's (mostly the compiler).

## Risks and unknowns

- **Link fidelity.** ESP-IDF's link relies on generated `sections.ld` (from
  linker fragments) and specific whole-archive groups. Harvesting them from a
  real build should reproduce it exactly; the producer's verification step is
  what proves it per release.
- **Profile coupling.** The runtime is compiled against the pack's
  `sdkconfig.h`. A feature needing a Kconfig change means a new profile (new
  pack), or the IDF fallback.
- **Bluetooth.** Today's sdkconfig has `CONFIG_BT_ENABLED` off, so `ble.c`
  cannot work yet. Enabling NimBLE in the profile adds archives to the pack;
  whether it costs RAM in programs that don't use BLE has to be measured.
- **ESP-IDF version bumps** mean new packs (CI job), like any toolchain bump.
- **Other chips** (ESP32-S3, C3) each get their own pack; C3 needs the RISC-V
  compiler.

## Spike result (2026-10-02)

Cabinet firmware, from a fresh ESP-IDF build directory, by a throwaway script:
Volt's 17 files recompiled with the harvested `compile_commands.json`
flags, archived as `libvolt.a` in place of `libmain.a`, linked with
ESP-IDF's own link line (`build.ninja`), imaged with the standalone
`esptool` 5.3.0.

| Step | Time |
|---|---|
| Compile 17 files (parallel) | 0.65 s |
| Link | 0.83 s |
| `esptool elf2image` | 5.2 s warm (PyInstaller start-up) |
| ESP-IDF build of the same firmware | 74.6 s |

The ELF's text/data/bss match ESP-IDF's exactly. With ESP-IDF's image
arguments (`--min-rev-full 0 --max-rev-full 399`, from sdkconfig) the app
image differs only in the embedded ELF SHA-256 (0xb0) and the trailing
checksum/digest: every loaded byte is identical. Consequences:
`build.json` must record ESP-IDF's exact `elf2image` arguments, and a Go
`elf2image` is worth doing early (it is now most of the build time).
Flashed with the standalone `esptool` (bootloader 0x1000, partition table
0x8000, app 0x10000) to an ESP32 DevKit V1: boots and runs the cabinet IDS
exactly as the ESP-IDF build does (same pre-existing SMS watchdog warning).

## Plan

0. **Spike (go/no-go, ~half a day).** By hand, from the cabinet build dir:
   compile Volt's 13 files with the harvested flags, link against the built
   archives and scripts outside CMake, make the image, compare size with the
   IDF build, flash and run on the board, time it.
1. `volt sdk build esp32` producer + verification.
2. Go build driver + `esptool` asset; `volt build`/`flash` use the pack.
3. Manifest assets (pack, trimmed compiler, esptool); GitHub Actions job;
   IDF path becomes `--idf`.
4. Go `elf2image` + partition tables; compiler trimming.

## Decisions needed

1. Profile contents: include NimBLE (BLE) now, or later?
2. Default flash size: today's sdkconfig says 2 MB; most ESP32 DevKit V1
   boards have 4 MB.
3. Keep the IDF fallback installable on demand (recommended), or remove it.
4. `esptool` standalone binary first and Go port later (recommended), or Go
   from the start.
