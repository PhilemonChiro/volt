#pragma once
#include <stdint.h>
#include <stdbool.h>
#include "volt/error.h"

// MFRC522 — RFID 13.56MHz (SPI)
typedef struct { uint8_t bus_id, cs_pin; uint8_t uid[10]; uint8_t uid_len; } mfrc522_t;
volt_error_t mfrc522_init(mfrc522_t *dev, uint8_t bus_id, uint8_t cs_pin);
int mfrc522_is_card_present(mfrc522_t *dev);
int mfrc522_read_uid(mfrc522_t *dev);
int mfrc522_uid_value(mfrc522_t *dev);
