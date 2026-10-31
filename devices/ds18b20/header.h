#pragma once
#include <stdint.h>
#include <stdbool.h>
#include "volt/error.h"

// DS18B20 — 1-Wire digital thermometer, one sensor per pin
typedef struct {
    uint8_t gpio;
    float celsius;          // last good reading
    bool connected;         // the last read got a valid answer
    bool converting;        // a conversion is running on the sensor
    uint32_t started_ms;    // when that conversion started
} ds18b20_t;

volt_error_t ds18b20_init(ds18b20_t *dev, uint8_t gpio);
float ds18b20_temperature(ds18b20_t *dev);
bool ds18b20_is_connected(ds18b20_t *dev);
