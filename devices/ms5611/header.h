#pragma once
#include <stdint.h>
#include <stdbool.h>
#include "volt/error.h"

// MS5611 — High-res Barometric Pressure (addr: 0x77)
typedef struct { uint8_t bus_id, addr; uint16_t C[7]; int32_t dT, TEMP; } ms5611_t;
volt_error_t ms5611_init(ms5611_t *dev, uint8_t bus_id, uint8_t addr);
float ms5611_temperature(ms5611_t *dev);
float ms5611_pressure(ms5611_t *dev);
