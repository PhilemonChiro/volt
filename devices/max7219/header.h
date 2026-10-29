#pragma once
#include <stdint.h>
#include <stdbool.h>
#include "volt/error.h"

// MAX7219 — LED Matrix/7-Segment (SPI)
typedef struct { uint8_t bus_id, cs_pin, num_devices; } max7219_t;
volt_error_t max7219_init(max7219_t *dev, uint8_t bus_id, uint8_t cs_pin);
void max7219_set_row(max7219_t *dev, uint8_t row, uint8_t data);
void max7219_set_intensity(max7219_t *dev, uint8_t level);
void max7219_clear(max7219_t *dev);
void max7219_set_digit(max7219_t *dev, uint8_t pos, uint8_t value, uint8_t dp);
