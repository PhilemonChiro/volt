#include <stdint.h>
#include <stdbool.h>
#include "volt/error.h"

typedef struct {
    uint8_t bus_id;
    uint8_t addr;
    uint16_t eco2;
    uint16_t tvoc;
    bool ok;
    uint64_t start_us;
    uint64_t last_us;
} sgp30_t;

volt_error_t sgp30_init(sgp30_t *dev, uint8_t bus_id, uint8_t addr);
int32_t sgp30_eco2(sgp30_t *dev);
int32_t sgp30_tvoc(sgp30_t *dev);
bool sgp30_ready(sgp30_t *dev);
void sgp30_set_humidity(sgp30_t *dev, float temp_c, float rh);
int32_t sgp30_baseline_eco2(sgp30_t *dev);
int32_t sgp30_baseline_tvoc(sgp30_t *dev);
void sgp30_set_baseline(sgp30_t *dev, int32_t eco2, int32_t tvoc);
