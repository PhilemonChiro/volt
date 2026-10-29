#pragma once
#include <stdint.h>
#include <stdbool.h>
#include "volt/error.h"

typedef struct { uint8_t bus_id, addr; float x, y, z; } hmc5883l_t;
volt_error_t hmc5883l_init(hmc5883l_t *dev, uint8_t bus_id, uint8_t addr);
float hmc5883l_x(hmc5883l_t *dev);
float hmc5883l_y(hmc5883l_t *dev);
float hmc5883l_z(hmc5883l_t *dev);
float hmc5883l_heading(hmc5883l_t *dev);
