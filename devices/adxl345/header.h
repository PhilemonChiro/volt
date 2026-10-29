#pragma once
#include <stdint.h>
#include <stdbool.h>
#include "volt/error.h"

// GY-85 9-DoF board: ADXL345 (0x53) + ITG3205 (0x68) + HMC5883L (0x1E)
typedef struct { uint8_t bus_id, addr; float x, y, z; } adxl345_t;
volt_error_t adxl345_init(adxl345_t *dev, uint8_t bus_id, uint8_t addr);
float adxl345_x(adxl345_t *dev);
float adxl345_y(adxl345_t *dev);
float adxl345_z(adxl345_t *dev);
float adxl345_magnitude(adxl345_t *dev);
