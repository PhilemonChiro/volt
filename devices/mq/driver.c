/* MQ-series analog gas sensors (MQ-2/3/4/5/7/8/9/135...) on an ADC pin */

#include "volt/pin.h"
#include "volt/log.h"
#include "volt/task.h"
#include <math.h>

#define MQ_SAMPLES   16
#define MQ_ADC_MAX   4095.0f
#define MQ_ADC_VREF  3.3f

volt_error_t mq_init(mq_t *dev, uint8_t pin)
{
    dev->pin = pin;
    dev->rl_kohm = 10.0f;
    dev->divider = 1.0f;
    dev->vc = 5.0f;
    dev->r0 = 10.0f;
    log_info("mq", "gas sensor on GPIO%d (calibrate or set_r0 before using ppm)", pin);
    return VOLT_OK;
}

int32_t mq_raw(mq_t *dev)
{
    int32_t sum = 0;
    for (int i = 0; i < MQ_SAMPLES; i++) {
        sum += pin_read_analog(dev->pin);
        volt_delay_ms(1);
    }
    return sum / MQ_SAMPLES;
}

float mq_voltage(mq_t *dev)
{
    return (float)mq_raw(dev) * MQ_ADC_VREF / MQ_ADC_MAX * dev->divider;
}

float mq_resistance(mq_t *dev)
{
    float v = mq_voltage(dev);
    if (v < 0.01f) v = 0.01f;            /* no gas / disconnected: avoid /0 */
    if (v > dev->vc) v = dev->vc;
    return dev->rl_kohm * (dev->vc - v) / v;
}

float mq_ratio(mq_t *dev)
{
    return mq_resistance(dev) / dev->r0;
}

float mq_ppm(mq_t *dev, float a, float b)
{
    float r = mq_ratio(dev);
    if (r <= 0.0f) return 0.0f;
    return a * powf(r, b);
}

float mq_calibrate(mq_t *dev, float clean_air_ratio)
{
    if (clean_air_ratio <= 0.0f) return dev->r0;
    float sum = 0.0f;
    for (int i = 0; i < 50; i++) {
        sum += mq_resistance(dev);
        volt_delay_ms(80);
    }
    dev->r0 = (sum / 50.0f) / clean_air_ratio;
    log_info("mq", "calibrated: R0 = %.2f kOhm", (double)dev->r0);
    return dev->r0;
}

float mq_r0(mq_t *dev)
{
    return dev->r0;
}

void mq_set_r0(mq_t *dev, float r0)
{
    if (r0 > 0.0f) dev->r0 = r0;
}

void mq_set_load(mq_t *dev, float rl_kohm)
{
    if (rl_kohm > 0.0f) dev->rl_kohm = rl_kohm;
}

void mq_set_divider(mq_t *dev, float factor)
{
    if (factor >= 1.0f) dev->divider = factor;
}

void mq_set_supply(mq_t *dev, float volts)
{
    if (volts > 0.0f) dev->vc = volts;
}
