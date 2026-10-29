#pragma once
#include <stdint.h>
#include <stdbool.h>
#include "volt/error.h"

// BME680 — Gas + Temp + Humidity + Pressure (addr: 0x76/0x77)
typedef struct { uint8_t bus_id, addr; float last_temp, last_hum, last_pres; uint32_t last_gas; } bme680_t;
volt_error_t bme680_init(bme680_t *dev, uint8_t bus_id, uint8_t addr);
float bme680_temperature(bme680_t *dev);
float bme680_humidity(bme680_t *dev);
float bme680_pressure(bme680_t *dev);
int bme680_gas(bme680_t *dev);
