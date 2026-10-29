#pragma once
#include <stdint.h>
#include <stdbool.h>
#include "volt/error.h"

// MAX30102 — Pulse Oximeter + Heart Rate (addr: 0x57)
typedef struct {
    uint8_t bus_id, addr;
    uint32_t ir_value, red_value;
    float temperature;
} max30102_t;
volt_error_t max30102_init(max30102_t *dev, uint8_t bus_id, uint8_t addr);
int max30102_red(max30102_t *dev);
int max30102_ir(max30102_t *dev);
float max30102_temperature(max30102_t *dev);
int max30102_is_finger_present(max30102_t *dev);
