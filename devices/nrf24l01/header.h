#pragma once
#include <stdint.h>
#include <stdbool.h>
#include "volt/error.h"

// nRF24L01+ — 2.4GHz Wireless (SPI + CE pin)
typedef struct { uint8_t bus_id, cs_pin, ce_pin, channel, payload_size; } nrf24l01_t;
volt_error_t nrf24l01_init(nrf24l01_t *dev, uint8_t bus_id, uint8_t cs_pin, uint8_t ce_pin, uint8_t channel);
int nrf24l01_send(nrf24l01_t *dev, const char *text);
int nrf24l01_send_bytes(nrf24l01_t *dev, const uint8_t *data, uint8_t len);
int nrf24l01_receive(nrf24l01_t *dev, uint8_t *buf, uint8_t max_len);
int nrf24l01_available(nrf24l01_t *dev);
