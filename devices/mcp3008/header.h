#pragma once
#include <stdint.h>
#include <stdbool.h>
#include "volt/error.h"

// MCP3008 — 8-Channel 10-bit ADC
typedef struct {
    uint8_t bus_id;
    uint8_t cs_pin;
} mcp3008_t;
volt_error_t mcp3008_init(mcp3008_t *dev, uint8_t bus_id, uint8_t cs_pin);
int mcp3008_read(mcp3008_t *dev, uint8_t channel);  // returns 0-1023
