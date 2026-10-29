#pragma once
#include <stdint.h>
#include <stdbool.h>
#include "volt/error.h"

// BMP180 — Barometric Pressure + Temperature (addr: 0x77)
typedef struct {
    uint8_t bus_id, addr;
    int16_t AC1, AC2, AC3;
    uint16_t AC4, AC5, AC6;
    int16_t B1, B2, MB, MC, MD;
    int32_t B5;
} bmp180_t;
volt_error_t bmp180_init(bmp180_t *dev, uint8_t bus_id, uint8_t addr);
float bmp180_temperature(bmp180_t *dev);
float bmp180_pressure(bmp180_t *dev);
