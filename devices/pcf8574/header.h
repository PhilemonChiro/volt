#pragma once
#include <stdint.h>
#include <stdbool.h>
#include "volt/error.h"

// PCF8574 — I2C GPIO Expander (addr: 0x20-0x27)
typedef struct {
    uint8_t bus_id, addr;
    uint8_t state;
} pcf8574_t;
volt_error_t pcf8574_init(pcf8574_t *dev, uint8_t bus_id, uint8_t addr);
void pcf8574_write(pcf8574_t *dev, uint8_t value);
uint8_t pcf8574_read(pcf8574_t *dev);
void pcf8574_set_pin(pcf8574_t *dev, uint8_t pin, uint8_t level);
