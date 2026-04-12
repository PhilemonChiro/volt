#include <stdint.h>
#include <string.h>
#include "volt/error.h"
#include "volt/log.h"

// RP2040 storage — stub implementation
// TODO: implement using flash sectors (hardware/flash.h) for persistence

volt_error_t storage_init(void) { return VOLT_OK; }

volt_error_t storage_save_int(const char *key, int value) {
    log_warn("storage", "storage not yet implemented on RP2040");
    return VOLT_ERR_NOT_SUPPORTED;
}

int storage_load_int(const char *key, int default_val) {
    return default_val;
}

volt_error_t storage_push(const char *list, int value) {
    return VOLT_ERR_NOT_SUPPORTED;
}

int storage_list_count(const char *list) {
    return 0;
}

volt_error_t storage_drain(const char *list, char *buf, int buf_size) {
    if (buf && buf_size > 0) buf[0] = '\0';
    return VOLT_OK;
}

volt_error_t storage_list_clear(const char *list) {
    return VOLT_OK;
}
