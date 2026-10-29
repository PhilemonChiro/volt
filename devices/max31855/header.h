#pragma once
#include <stdint.h>
#include <stdbool.h>
#include "volt/error.h"

// MAX31855 — Thermocouple Temperature (read-only)
typedef struct {
    uint8_t bus_id;
    uint8_t cs_pin;
    float thermocouple_temp;
    float internal_temp;
    uint8_t fault;
} max31855_t;
volt_error_t max31855_init(max31855_t *dev, uint8_t bus_id, uint8_t cs_pin);
float max31855_temperature(max31855_t *dev);  // thermocouple temp (°C)
float max31855_internal(max31855_t *dev);      // cold junction temp (°C)
int max31855_is_fault(max31855_t *dev);        // 1 if fault detected
