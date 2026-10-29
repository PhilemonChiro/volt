#pragma once
#include <stdint.h>
#include <stdbool.h>
#include "volt/error.h"

// HTU21D — Temperature + Humidity (addr: 0x40)
typedef struct { uint8_t bus_id, addr; } htu21d_t;
volt_error_t htu21d_init(htu21d_t *dev, uint8_t bus_id, uint8_t addr);
float htu21d_temperature(htu21d_t *dev);
float htu21d_humidity(htu21d_t *dev);
