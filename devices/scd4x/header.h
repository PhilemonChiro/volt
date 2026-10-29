#include <stdint.h>
#include <stdbool.h>
#include "volt/error.h"

typedef struct {
    uint8_t bus_id;
    uint8_t addr;
    uint16_t co2;
    float temperature;
    float humidity;
    bool has_data;
} scd4x_t;

volt_error_t scd4x_init(scd4x_t *dev, uint8_t bus_id, uint8_t addr);
int32_t scd4x_co2(scd4x_t *dev);
float scd4x_temperature(scd4x_t *dev);
float scd4x_humidity(scd4x_t *dev);
bool scd4x_ready(scd4x_t *dev);
void scd4x_set_pressure(scd4x_t *dev, int32_t hpa);
void scd4x_set_temperature_offset(scd4x_t *dev, float offset);
void scd4x_set_auto_calibration(scd4x_t *dev, bool on);
int32_t scd4x_calibrate(scd4x_t *dev, int32_t target_ppm);
