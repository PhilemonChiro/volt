#include "volt/system.h"
#include "pico/stdlib.h"
#include "pico/time.h"
#include "pico/unique_id.h"
#include "hardware/watchdog.h"

void system_restart(void)
{
    watchdog_reboot(0, 0, 0);
    // If watchdog reboot not available, spin forever
    while (1) tight_loop_contents();
}

uint32_t system_free_heap(void)
{
    // RP2040 doesn't have a heap allocator by default
    // Return 0 to indicate "not tracked"
    extern char __StackLimit, __bss_end__;
    return (uint32_t)(&__StackLimit - &__bss_end__);
}

uint32_t system_uptime(void)
{
    return to_ms_since_boot(get_absolute_time()) / 1000;
}

uint32_t system_id(void)
{
    pico_unique_board_id_t id;
    pico_get_unique_board_id(&id);
    // Return first 4 bytes as a uint32
    return (uint32_t)id.id[0] | ((uint32_t)id.id[1] << 8) |
           ((uint32_t)id.id[2] << 16) | ((uint32_t)id.id[3] << 24);
}

void system_deep_sleep(uint64_t duration_us)
{
    // RP2040 doesn't have true deep sleep like ESP32
    // Use dormant mode or just sleep
    sleep_us(duration_us);
}

void system_light_sleep(void)
{
    // Light sleep — use WFI (Wait For Interrupt)
    __wfi();
}

// ---- Watchdog ----

static bool wdt_enabled = false;

// Pico SDK has its own watchdog_enable() with different signature.
// We use volt_ prefix internally, aliased via the header.
void volt_wdt_enable(uint32_t timeout_ms)
{
    if (wdt_enabled) return;
    // RP2040 watchdog max is ~8.3 seconds (8388ms)
    if (timeout_ms > 8388) timeout_ms = 8388;
    watchdog_enable(timeout_ms, true);  // Pico SDK call, true = pause on debug
    wdt_enabled = true;
}

void volt_wdt_feed(void)
{
    if (wdt_enabled) {
        watchdog_update();
    }
}

void volt_wdt_disable(void)
{
    // RP2040 watchdog cannot be disabled once enabled — only reset stops it.
    // This is a hardware limitation. Feed continuously instead.
    wdt_enabled = false;
}
