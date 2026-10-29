#include <stdint.h>
#include <stdbool.h>
#include "volt/error.h"

typedef struct {
    uint8_t bus_id;
    uint8_t addr;
} ens160_t;

volt_error_t ens160_init(ens160_t *dev, uint8_t bus_id, uint8_t addr);
int32_t ens160_aqi(ens160_t *dev);
int32_t ens160_tvoc(ens160_t *dev);
int32_t ens160_eco2(ens160_t *dev);
int32_t ens160_status(ens160_t *dev);
bool ens160_ready(ens160_t *dev);
void ens160_set_compensation(ens160_t *dev, float temp_c, float rh);
