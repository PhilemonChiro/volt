#ifndef VOLT_SPI_DEVICES_H
#define VOLT_SPI_DEVICES_H

#include <stdint.h>
#include "volt/error.h"

// ============================================================
// W25Qxx — SPI Flash Memory (W25Q32/Q64/Q128)
// ============================================================
typedef struct {
    uint8_t bus_id;
    uint8_t cs_pin;
    uint8_t manufacturer;
    uint8_t device_id;
    uint32_t capacity;
} w25q_t;

volt_error_t w25q_init(w25q_t *dev, uint8_t bus_id, uint8_t cs_pin);
volt_error_t w25q_read(w25q_t *dev, uint32_t addr, uint8_t *buf, uint16_t len);
volt_error_t w25q_write_page(w25q_t *dev, uint32_t addr, const uint8_t *data, uint16_t len);
volt_error_t w25q_erase_sector(w25q_t *dev, uint32_t addr);
volt_error_t w25q_erase_chip(w25q_t *dev);

// ============================================================
// MAX31855 — Thermocouple Temperature (read-only)
// ============================================================
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

// ============================================================
// MCP3008 — 8-Channel 10-bit ADC
// ============================================================
typedef struct {
    uint8_t bus_id;
    uint8_t cs_pin;
} mcp3008_t;

volt_error_t mcp3008_init(mcp3008_t *dev, uint8_t bus_id, uint8_t cs_pin);
int mcp3008_read(mcp3008_t *dev, uint8_t channel);  // returns 0-1023

#endif // VOLT_SPI_DEVICES_H
