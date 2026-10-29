#pragma once
#include <stdint.h>
#include <stdbool.h>
#include "volt/error.h"

// MLX90614 — Non-contact IR Temperature (addr: 0x5A)
typedef struct {
    uint8_t bus_id, addr;
} mlx90614_t;
volt_error_t mlx90614_init(mlx90614_t *dev, uint8_t bus_id, uint8_t addr);
float mlx90614_ambient(mlx90614_t *dev);
float mlx90614_object(mlx90614_t *dev);
