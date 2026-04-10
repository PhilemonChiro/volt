#include "volt/storage.h"
#include "volt/log.h"

#include <string.h>
#include "nvs_flash.h"
#include "nvs.h"
#include "esp_timer.h"
#include "esp_system.h"
#include "esp_event.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

// Shutdown handler: flush dirty storage before reboot/brownout
static void shutdown_flush_handler(void)
{
    storage_flush();
}

// All Volt storage goes into one NVS namespace
#define VOLT_NVS_NAMESPACE "volt"

// Write coalescing: dirty values are buffered in RAM and flushed
// to flash every FLUSH_INTERVAL_MS or on explicit storage_flush().
#define FLUSH_INTERVAL_MS 30000
#define MAX_DIRTY_ENTRIES 16

// Boot loop detection: if the device boots more than MAX_BOOT_CRASHES
// times without staying alive for MIN_STABLE_MS, trigger factory reset.
#define MAX_BOOT_CRASHES 5
#define MIN_STABLE_MS    60000

// ============================================================
// Write coalescing buffer
// ============================================================

typedef enum {
    DIRTY_INT,
    DIRTY_FLOAT,
    DIRTY_STR,
} dirty_type_t;

typedef struct {
    char key[16];           // NVS max key is 15 chars + null
    dirty_type_t type;
    union {
        int    i;
        float  f;
        char   s[64];
    } value;
    bool active;            // slot in use
} dirty_entry_t;

static dirty_entry_t s_dirty[MAX_DIRTY_ENTRIES];
static bool s_initialized = false;
static esp_timer_handle_t s_flush_timer = NULL;

// ============================================================
// Internal helpers
// ============================================================

// Open NVS handle, perform operation, close. Returns ESP_OK or error.
static esp_err_t nvs_open_handle(nvs_handle_t *handle, nvs_open_mode_t mode)
{
    return nvs_open(VOLT_NVS_NAMESPACE, mode, handle);
}

// Find existing dirty entry for a key, or find an empty slot
static dirty_entry_t *find_dirty_slot(const char *key)
{
    dirty_entry_t *empty = NULL;

    for (int i = 0; i < MAX_DIRTY_ENTRIES; i++) {
        if (s_dirty[i].active && strcmp(s_dirty[i].key, key) == 0) {
            return &s_dirty[i];  // existing entry for this key
        }
        if (!s_dirty[i].active && empty == NULL) {
            empty = &s_dirty[i]; // first empty slot
        }
    }

    return empty;  // NULL if buffer is full
}

// Flush timer callback — writes all dirty values to flash
static void flush_timer_callback(void *arg)
{
    storage_flush();
}

// ============================================================
// Boot loop detection
// ============================================================

static void check_boot_loop(void)
{
    nvs_handle_t handle;
    if (nvs_open_handle(&handle, NVS_READWRITE) != ESP_OK) return;

    // Read crash counter
    int32_t crash_count = 0;
    nvs_get_i32(handle, "_crashes", &crash_count);

    if (crash_count >= MAX_BOOT_CRASHES) {
        log_error("storage", "boot loop detected (%ld crashes) — factory reset", (long)crash_count);
        nvs_close(handle);
        storage_factory_reset();
        return;  // never reaches here — factory_reset reboots
    }

    // Increment crash counter
    crash_count++;
    nvs_set_i32(handle, "_crashes", crash_count);
    nvs_commit(handle);
    nvs_close(handle);

    log_debug("storage", "boot count: %ld (resets after %ds stable)",
              (long)crash_count, MIN_STABLE_MS / 1000);

    // Crash counter is cleared in storage_flush() after MIN_STABLE_MS
}

// Clear the crash counter — called once the device has been stable
static void clear_crash_counter(void)
{
    nvs_handle_t handle;
    if (nvs_open_handle(&handle, NVS_READWRITE) != ESP_OK) return;
    nvs_set_i32(handle, "_crashes", 0);
    nvs_commit(handle);
    nvs_close(handle);
    log_debug("storage", "boot stable — crash counter cleared");
}

// ============================================================
// Public API
// ============================================================

volt_error_t storage_init(void)
{
    if (s_initialized) return VOLT_OK;

    // Initialize NVS flash
    esp_err_t err = nvs_flash_init();
    if (err == ESP_ERR_NVS_NO_FREE_PAGES || err == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        log_warn("storage", "NVS partition issue — erasing and reinitializing");
        nvs_flash_erase();
        err = nvs_flash_init();
    }
    if (err != ESP_OK) {
        log_error("storage", "NVS init failed (esp_err=%d)", err);
        return VOLT_ERR_STORAGE_INIT_FAILED;
    }

    // Clear dirty buffer
    memset(s_dirty, 0, sizeof(s_dirty));

    // Boot loop detection
    check_boot_loop();

    // Start flush timer — writes dirty values to flash every 30 seconds
    esp_timer_create_args_t timer_args = {
        .callback = flush_timer_callback,
        .name = "nvs_flush",
    };
    esp_timer_create(&timer_args, &s_flush_timer);
    esp_timer_start_periodic(s_flush_timer, FLUSH_INTERVAL_MS * 1000);

    // Register shutdown handler — flushes dirty data before reboot/OTA/brownout
    esp_register_shutdown_handler(shutdown_flush_handler);

    s_initialized = true;

    // Log health on startup
    storage_health_t health = storage_get_health();
    log_info("storage", "initialized — %lu/%lu entries used (%d%%)",
             (unsigned long)health.used_entries,
             (unsigned long)(health.used_entries + health.free_entries),
             health.usage_pct);

    return VOLT_OK;
}

volt_error_t storage_save_int(const char *key, int value)
{
    if (!s_initialized) storage_init();
    if (key == NULL || strlen(key) > 15) return VOLT_ERR_INVALID_ARG;

    dirty_entry_t *slot = find_dirty_slot(key);
    if (slot == NULL) {
        // Buffer full — flush first, then retry
        storage_flush();
        slot = find_dirty_slot(key);
        if (slot == NULL) return VOLT_ERR_STORAGE_FULL;
    }

    strncpy(slot->key, key, 15);
    slot->key[15] = '\0';
    slot->type = DIRTY_INT;
    slot->value.i = value;
    slot->active = true;

    return VOLT_OK;
}

int storage_load_int(const char *key, int default_val)
{
    if (!s_initialized) storage_init();
    if (key == NULL) return default_val;

    // Check dirty buffer first — may have unflushed value
    for (int i = 0; i < MAX_DIRTY_ENTRIES; i++) {
        if (s_dirty[i].active && s_dirty[i].type == DIRTY_INT &&
            strcmp(s_dirty[i].key, key) == 0) {
            return s_dirty[i].value.i;
        }
    }

    // Read from NVS
    nvs_handle_t handle;
    if (nvs_open_handle(&handle, NVS_READONLY) != ESP_OK) return default_val;

    int32_t value;
    esp_err_t err = nvs_get_i32(handle, key, &value);
    nvs_close(handle);

    return (err == ESP_OK) ? (int)value : default_val;
}

volt_error_t storage_save_float(const char *key, float value)
{
    if (!s_initialized) storage_init();
    if (key == NULL || strlen(key) > 15) return VOLT_ERR_INVALID_ARG;

    dirty_entry_t *slot = find_dirty_slot(key);
    if (slot == NULL) {
        storage_flush();
        slot = find_dirty_slot(key);
        if (slot == NULL) return VOLT_ERR_STORAGE_FULL;
    }

    strncpy(slot->key, key, 15);
    slot->key[15] = '\0';
    slot->type = DIRTY_FLOAT;
    slot->value.f = value;
    slot->active = true;

    return VOLT_OK;
}

float storage_load_float(const char *key, float default_val)
{
    if (!s_initialized) storage_init();
    if (key == NULL) return default_val;

    // Check dirty buffer first
    for (int i = 0; i < MAX_DIRTY_ENTRIES; i++) {
        if (s_dirty[i].active && s_dirty[i].type == DIRTY_FLOAT &&
            strcmp(s_dirty[i].key, key) == 0) {
            return s_dirty[i].value.f;
        }
    }

    // NVS doesn't have a native float type — we store as blob
    nvs_handle_t handle;
    if (nvs_open_handle(&handle, NVS_READONLY) != ESP_OK) return default_val;

    float value;
    size_t len = sizeof(float);
    esp_err_t err = nvs_get_blob(handle, key, &value, &len);
    nvs_close(handle);

    return (err == ESP_OK) ? value : default_val;
}

volt_error_t storage_save_str(const char *key, const char *value)
{
    if (!s_initialized) storage_init();
    if (key == NULL || value == NULL || strlen(key) > 15) return VOLT_ERR_INVALID_ARG;

    dirty_entry_t *slot = find_dirty_slot(key);
    if (slot == NULL) {
        storage_flush();
        slot = find_dirty_slot(key);
        if (slot == NULL) return VOLT_ERR_STORAGE_FULL;
    }

    strncpy(slot->key, key, 15);
    slot->key[15] = '\0';
    slot->type = DIRTY_STR;
    strncpy(slot->value.s, value, sizeof(slot->value.s) - 1);
    slot->value.s[sizeof(slot->value.s) - 1] = '\0';
    slot->active = true;

    return VOLT_OK;
}

volt_error_t storage_load_str(const char *key, char *buf, size_t buf_size,
                               const char *default_val)
{
    if (!s_initialized) storage_init();
    if (key == NULL || buf == NULL || buf_size == 0) return VOLT_ERR_INVALID_ARG;

    // Check dirty buffer first
    for (int i = 0; i < MAX_DIRTY_ENTRIES; i++) {
        if (s_dirty[i].active && s_dirty[i].type == DIRTY_STR &&
            strcmp(s_dirty[i].key, key) == 0) {
            strncpy(buf, s_dirty[i].value.s, buf_size - 1);
            buf[buf_size - 1] = '\0';
            return VOLT_OK;
        }
    }

    // Read from NVS
    nvs_handle_t handle;
    if (nvs_open_handle(&handle, NVS_READONLY) != ESP_OK) {
        if (default_val) strncpy(buf, default_val, buf_size - 1);
        buf[buf_size - 1] = '\0';
        return VOLT_ERR_KEY_NOT_FOUND;
    }

    size_t len = buf_size;
    esp_err_t err = nvs_get_str(handle, key, buf, &len);
    nvs_close(handle);

    if (err != ESP_OK) {
        if (default_val) strncpy(buf, default_val, buf_size - 1);
        buf[buf_size - 1] = '\0';
        return VOLT_ERR_KEY_NOT_FOUND;
    }

    return VOLT_OK;
}

volt_error_t storage_delete(const char *key)
{
    if (!s_initialized) storage_init();
    if (key == NULL) return VOLT_ERR_INVALID_ARG;

    // Remove from dirty buffer if present
    for (int i = 0; i < MAX_DIRTY_ENTRIES; i++) {
        if (s_dirty[i].active && strcmp(s_dirty[i].key, key) == 0) {
            s_dirty[i].active = false;
        }
    }

    // Remove from NVS
    nvs_handle_t handle;
    if (nvs_open_handle(&handle, NVS_READWRITE) != ESP_OK) return VOLT_ERR_STORAGE_WRITE_FAILED;

    nvs_erase_key(handle, key);
    nvs_commit(handle);
    nvs_close(handle);

    return VOLT_OK;
}

bool storage_exists(const char *key)
{
    if (!s_initialized) storage_init();
    if (key == NULL) return false;

    // Check dirty buffer first
    for (int i = 0; i < MAX_DIRTY_ENTRIES; i++) {
        if (s_dirty[i].active && strcmp(s_dirty[i].key, key) == 0) {
            return true;
        }
    }

    // Check NVS using nvs_find_key (ESP-IDF v5.3+)
    // This checks existence without reading the value or knowing the type.
    nvs_handle_t handle;
    if (nvs_open_handle(&handle, NVS_READONLY) != ESP_OK) return false;

    nvs_type_t type;
    esp_err_t err = nvs_find_key(handle, key, &type);
    nvs_close(handle);

    return (err == ESP_OK);
}

volt_error_t storage_flush(void)
{
    if (!s_initialized) return VOLT_OK;

    // Count dirty entries
    int dirty_count = 0;
    for (int i = 0; i < MAX_DIRTY_ENTRIES; i++) {
        if (s_dirty[i].active) dirty_count++;
    }
    if (dirty_count == 0) return VOLT_OK;

    nvs_handle_t handle;
    esp_err_t err = nvs_open_handle(&handle, NVS_READWRITE);
    if (err != ESP_OK) {
        log_error("storage", "flush failed — can't open NVS");
        return VOLT_ERR_STORAGE_WRITE_FAILED;
    }

    int written = 0;
    for (int i = 0; i < MAX_DIRTY_ENTRIES; i++) {
        if (!s_dirty[i].active) continue;

        switch (s_dirty[i].type) {
            case DIRTY_INT:
                nvs_set_i32(handle, s_dirty[i].key, s_dirty[i].value.i);
                break;
            case DIRTY_FLOAT:
                nvs_set_blob(handle, s_dirty[i].key, &s_dirty[i].value.f, sizeof(float));
                break;
            case DIRTY_STR:
                nvs_set_str(handle, s_dirty[i].key, s_dirty[i].value.s);
                break;
        }

        s_dirty[i].active = false;
        written++;
    }

    nvs_commit(handle);
    nvs_close(handle);

    // Clear crash counter after stable operation
    static bool crash_cleared = false;
    static uint32_t init_tick = 0;
    if (!crash_cleared) {
        if (init_tick == 0) init_tick = xTaskGetTickCount() * portTICK_PERIOD_MS;
        uint32_t now = xTaskGetTickCount() * portTICK_PERIOD_MS;
        if (now - init_tick > MIN_STABLE_MS) {
            clear_crash_counter();
            crash_cleared = true;
        }
    }

    log_debug("storage", "flushed %d entries to flash", written);
    return VOLT_OK;
}

storage_health_t storage_get_health(void)
{
    storage_health_t health = {0};

    nvs_stats_t stats;
    if (nvs_get_stats(VOLT_NVS_NAMESPACE, &stats) == ESP_OK) {
        health.used_entries = stats.used_entries;
        health.free_entries = stats.free_entries;
        uint32_t total = stats.used_entries + stats.free_entries;
        health.usage_pct = total > 0 ? (uint8_t)(100 * stats.used_entries / total) : 0;
    }

    return health;
}

volt_error_t storage_factory_reset(void)
{
    log_warn("storage", "FACTORY RESET — erasing all data");
    nvs_flash_erase();
    log_warn("storage", "rebooting...");
    esp_restart();
    return VOLT_OK;  // never reaches here
}
