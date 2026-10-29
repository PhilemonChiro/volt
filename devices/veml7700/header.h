#pragma once
#include <stdint.h>
#include <stdbool.h>
#include "volt/error.h"

// VEML7700 — High-accuracy Light Sensor (addr: 0x10)
typedef struct {
    uint8_t bus_id, addr;
} veml7700_t;
volt_error_t veml7700_init(veml7700_t *dev, uint8_t bus_id, uint8_t addr);
float veml7700_lux(veml7700_t *dev);
float veml7700_white(veml7700_t *dev);
