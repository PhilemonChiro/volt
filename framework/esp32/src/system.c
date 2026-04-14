#include "volt/system.h"
#include "esp_system.h"
#include "esp_timer.h"
#include "esp_sleep.h"

void system_restart(void)
{
    esp_restart();
}

uint32_t system_free_heap(void)
{
    return esp_get_free_heap_size();
}

uint32_t system_uptime(void)
{
    return (uint32_t)(esp_timer_get_time() / 1000000);
}

uint32_t system_id(void)
{
    return 0; // placeholder
}

void system_deep_sleep(uint64_t duration_us)
{
    esp_deep_sleep(duration_us);
}

void system_light_sleep(void)
{
    esp_light_sleep_start();
}
