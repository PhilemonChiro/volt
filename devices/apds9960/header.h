#pragma once
#include <stdint.h>
#include <stdbool.h>
#include "volt/error.h"

// APDS9960 — Gesture/Proximity/RGB (addr: 0x39)
typedef struct { uint8_t bus_id, addr; } apds9960_t;
volt_error_t apds9960_init(apds9960_t *dev, uint8_t bus_id, uint8_t addr);
int apds9960_proximity(apds9960_t *dev);
int apds9960_red(apds9960_t *dev);
int apds9960_green(apds9960_t *dev);
int apds9960_blue(apds9960_t *dev);
int apds9960_clear(apds9960_t *dev);
