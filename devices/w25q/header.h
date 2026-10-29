#pragma once
#include <stdint.h>
#include <stdbool.h>
#include "volt/error.h"

// W25Qxx — SPI Flash Memory (W25Q32/Q64/Q128)
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
