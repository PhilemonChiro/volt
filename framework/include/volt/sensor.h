#ifndef VOLT_SENSOR_H
#define VOLT_SENSOR_H

#include <stdint.h>
#include "volt/error.h"

// ============================================================
// BME280 — Temperature, Humidity, Pressure
// ============================================================

typedef struct {
    uint8_t bus_id;
    uint8_t addr;
    // Calibration data (loaded on init)
    uint16_t dig_T1;
    int16_t  dig_T2, dig_T3;
    uint16_t dig_P1;
    int16_t  dig_P2, dig_P3, dig_P4, dig_P5, dig_P6, dig_P7, dig_P8, dig_P9;
    uint8_t  dig_H1, dig_H3;
    int16_t  dig_H2, dig_H4, dig_H5;
    int8_t   dig_H6;
    int32_t  t_fine; // shared between temp and pressure calculations
} bme280_t;

volt_error_t bme280_init(bme280_t *dev, uint8_t bus_id, uint8_t addr);
float bme280_temperature(bme280_t *dev);
float bme280_humidity(bme280_t *dev);
float bme280_pressure(bme280_t *dev);

// ============================================================
// BH1750 — Light Sensor
// ============================================================

typedef struct {
    uint8_t bus_id;
    uint8_t addr;
} bh1750_t;

volt_error_t bh1750_init(bh1750_t *dev, uint8_t bus_id, uint8_t addr);
float bh1750_lux(bh1750_t *dev);

// ============================================================
// SSD1306 — OLED Display 128x64
// ============================================================

typedef struct {
    uint8_t bus_id;
    uint8_t addr;
    uint8_t buffer[1024]; // 128x64 / 8 = 1024 bytes
} ssd1306_t;

volt_error_t ssd1306_init(ssd1306_t *dev, uint8_t bus_id, uint8_t addr);
void ssd1306_clear(ssd1306_t *dev);
void ssd1306_text(ssd1306_t *dev, int x, int y, const char *text);
void ssd1306_show(ssd1306_t *dev);

#endif // VOLT_SENSOR_H
