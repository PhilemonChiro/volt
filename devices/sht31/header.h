#pragma once
#include <stdint.h>
#include <stdbool.h>
#include "volt/error.h"

// SHT31 — High-accuracy Temp + Humidity (addr: 0x44/0x45)
typedef struct {
    uint8_t bus_id, addr;
    float last_temperature, last_humidity;
} sht31_t;
volt_error_t sht31_init(sht31_t *dev, uint8_t bus_id, uint8_t addr);
float sht31_temperature(sht31_t *dev);
float sht31_humidity(sht31_t *dev);
