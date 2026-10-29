#pragma once
#include <stdint.h>
#include <stdbool.h>
#include "volt/error.h"

// PCA9685 — 16-channel PWM/Servo controller (addr: 0x40)
typedef struct {
    uint8_t bus_id, addr;
    float frequency;
} pca9685_t;
volt_error_t pca9685_init(pca9685_t *dev, uint8_t bus_id, uint8_t addr);
void pca9685_set_pwm(pca9685_t *dev, uint8_t channel, uint16_t on, uint16_t off);
void pca9685_set_servo(pca9685_t *dev, uint8_t channel, int angle);
void pca9685_set_duty(pca9685_t *dev, uint8_t channel, uint8_t duty);
