/* HC-SR04 Ultrasonic Distance Sensor (2 GPIO pins: trigger + echo) */

#include "volt/pin.h"
#include "volt/log.h"
#include "volt/task.h"
#include <stdint.h>

typedef struct {
    uint8_t trig_pin, echo_pin;
} hcsr04_t;

volt_error_t hcsr04_init(hcsr04_t *dev, uint8_t trig, uint8_t echo)
{
    dev->trig_pin = trig;
    dev->echo_pin = echo;
    pin_set_output(trig);
    pin_set_input(echo);
    pin_write(trig, 0);
    log_info("hcsr04", "ultrasonic: trig=GPIO%d echo=GPIO%d", trig, echo);
    return VOLT_OK;
}

float hcsr04_distance_cm(hcsr04_t *dev)
{
    // Send 10us trigger pulse
    pin_write(dev->trig_pin, 0);
    // Brief delay
    for (volatile int i = 0; i < 10; i++);
    pin_write(dev->trig_pin, 1);
    for (volatile int i = 0; i < 100; i++);  // ~10us at typical MCU speeds
    pin_write(dev->trig_pin, 0);

    // Wait for echo to go high
    uint32_t start = volt_tick_us();
    uint32_t timeout = start + 30000;  // 30ms max
    while (pin_read(dev->echo_pin) == 0) {
        if (volt_tick_us() > timeout) return -1.0f;
    }

    // Measure echo high duration
    uint32_t echo_start = volt_tick_us();
    while (pin_read(dev->echo_pin) == 1) {
        if (volt_tick_us() > timeout) return -1.0f;
    }
    uint32_t echo_end = volt_tick_us();

    // Distance = (time_us / 2) / 29.1 cm
    float duration_us = (float)(echo_end - echo_start);
    return duration_us / 58.0f;  // cm
}
