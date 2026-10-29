#pragma once
#include <stdint.h>
#include <stdbool.h>
#include "volt/error.h"

// MAX30100 — Pulse Oximeter (older, 16-bit, addr: 0x57)
typedef struct {
    uint8_t bus_id, addr;
    uint16_t ir_value, red_value;
    float temperature;
} max30100_t;
volt_error_t max30100_init(max30100_t *dev, uint8_t bus_id, uint8_t addr);
int max30100_red(max30100_t *dev);
int max30100_ir(max30100_t *dev);
float max30100_temperature(max30100_t *dev);
int max30100_is_finger_present(max30100_t *dev);
