#pragma once
#include <stdint.h>
#include <stdbool.h>
#include "volt/error.h"

// INA219 — Current/Voltage/Power monitor (addr: 0x40-0x4F)
typedef struct {
    uint8_t bus_id, addr;
    float current_lsb;  // amps per bit (set during calibration)
} ina219_t;
volt_error_t ina219_init(ina219_t *dev, uint8_t bus_id, uint8_t addr);
float ina219_voltage(ina219_t *dev);      // bus voltage (V)
float ina219_current(ina219_t *dev);      // current (A)
float ina219_power(ina219_t *dev);        // power (W)
float ina219_shunt_voltage(ina219_t *dev); // shunt voltage (V)
