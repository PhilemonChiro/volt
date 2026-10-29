#include <stdint.h>
#include <stdbool.h>
#include "volt/error.h"

typedef struct {
    uint8_t pin;
    float rl_kohm;
    float divider;
    float vc;
    float r0;
} mq_t;

volt_error_t mq_init(mq_t *dev, uint8_t pin);
int32_t mq_raw(mq_t *dev);
float mq_voltage(mq_t *dev);
float mq_resistance(mq_t *dev);
float mq_ratio(mq_t *dev);
float mq_ppm(mq_t *dev, float a, float b);
float mq_calibrate(mq_t *dev, float clean_air_ratio);
float mq_r0(mq_t *dev);
void mq_set_r0(mq_t *dev, float r0);
void mq_set_load(mq_t *dev, float rl_kohm);
void mq_set_divider(mq_t *dev, float factor);
void mq_set_supply(mq_t *dev, float volts);
