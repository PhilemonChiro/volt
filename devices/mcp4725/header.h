#pragma once
#include <stdint.h>
#include <stdbool.h>
#include "volt/error.h"

// MCP4725 — 12-bit DAC (addr: 0x60/0x61)
typedef struct {
    uint8_t bus_id, addr;
} mcp4725_t;
volt_error_t mcp4725_init(mcp4725_t *dev, uint8_t bus_id, uint8_t addr);
void mcp4725_write(mcp4725_t *dev, uint16_t value);
void mcp4725_set_voltage(mcp4725_t *dev, float voltage, float vref);
