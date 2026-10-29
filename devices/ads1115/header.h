#pragma once
#include <stdint.h>
#include <stdbool.h>
#include "volt/error.h"

// ADS1115 — 16-bit 4-channel ADC (addr: 0x48-0x4B)
typedef struct {
    uint8_t bus_id, addr;
    float gain_voltage;
} ads1115_t;
volt_error_t ads1115_init(ads1115_t *dev, uint8_t bus_id, uint8_t addr);
int ads1115_read_raw(ads1115_t *dev, uint8_t channel);
float ads1115_voltage(ads1115_t *dev, uint8_t channel);
