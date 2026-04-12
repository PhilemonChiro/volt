#ifndef VOLT_SYSTEM_H
#define VOLT_SYSTEM_H

#include <stdint.h>

// Reboot the device immediately.
void system_restart(void);

// Available heap RAM in bytes.
uint32_t system_free_heap(void);

// Seconds since last boot.
uint32_t system_uptime(void);

// Chip/device unique ID.
uint32_t system_id(void);

// Deep sleep — all RAM lost, wakes via timer.
// duration_us: microseconds to sleep.
void system_deep_sleep(uint64_t duration_us);

// Light sleep — RAM preserved, faster wake.
void system_light_sleep(void);

#endif // VOLT_SYSTEM_H
