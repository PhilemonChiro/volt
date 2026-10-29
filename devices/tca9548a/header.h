#pragma once
#include <stdint.h>
#include <stdbool.h>
#include "volt/error.h"

// TCA9548A — I2C Multiplexer (addr: 0x70)
typedef struct { uint8_t bus_id, addr, current_channel; } tca9548a_t;
volt_error_t tca9548a_init(tca9548a_t *dev, uint8_t bus_id, uint8_t addr);
void tca9548a_select(tca9548a_t *dev, uint8_t channel);
void tca9548a_disable(tca9548a_t *dev);
