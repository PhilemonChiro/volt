#pragma once
#include <stdint.h>
#include <stdbool.h>
#include "volt/error.h"

// QMC5883L — Compass/Magnetometer (addr: 0x0D)
typedef struct { uint8_t bus_id, addr; float x, y, z; } qmc5883l_t;
volt_error_t qmc5883l_init(qmc5883l_t *dev, uint8_t bus_id, uint8_t addr);
float qmc5883l_x(qmc5883l_t *dev);
float qmc5883l_y(qmc5883l_t *dev);
float qmc5883l_z(qmc5883l_t *dev);
float qmc5883l_heading(qmc5883l_t *dev);
