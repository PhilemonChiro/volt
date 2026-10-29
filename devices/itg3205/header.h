#pragma once
#include <stdint.h>
#include <stdbool.h>
#include "volt/error.h"

typedef struct { uint8_t bus_id, addr; float x, y, z; } itg3205_t;
volt_error_t itg3205_init(itg3205_t *dev, uint8_t bus_id, uint8_t addr);
float itg3205_x(itg3205_t *dev);
float itg3205_y(itg3205_t *dev);
float itg3205_z(itg3205_t *dev);
float itg3205_magnitude(itg3205_t *dev);
