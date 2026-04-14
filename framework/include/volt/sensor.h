#ifndef VOLT_SENSOR_H
#define VOLT_SENSOR_H

#include <stdint.h>
#include "volt/error.h"

// ============================================================
// BME280 — Temperature, Humidity, Pressure (addr: 0x76/0x77)
// ============================================================
typedef struct {
    uint8_t bus_id, addr;
    uint16_t dig_T1;
    int16_t  dig_T2, dig_T3;
    uint16_t dig_P1;
    int16_t  dig_P2, dig_P3, dig_P4, dig_P5, dig_P6, dig_P7, dig_P8, dig_P9;
    uint8_t  dig_H1, dig_H3;
    int16_t  dig_H2, dig_H4, dig_H5;
    int8_t   dig_H6;
    int32_t  t_fine;
} bme280_t;

volt_error_t bme280_init(bme280_t *dev, uint8_t bus_id, uint8_t addr);
float bme280_temperature(bme280_t *dev);
float bme280_humidity(bme280_t *dev);
float bme280_pressure(bme280_t *dev);

// ============================================================
// AHT20 — Temperature + Humidity (addr: 0x38)
// ============================================================
typedef struct {
    uint8_t bus_id, addr;
    float last_temperature, last_humidity;
} aht20_t;

volt_error_t aht20_init(aht20_t *dev, uint8_t bus_id, uint8_t addr);
float aht20_temperature(aht20_t *dev);
float aht20_humidity(aht20_t *dev);

// ============================================================
// SHT31 — High-accuracy Temp + Humidity (addr: 0x44/0x45)
// ============================================================
typedef struct {
    uint8_t bus_id, addr;
    float last_temperature, last_humidity;
} sht31_t;

volt_error_t sht31_init(sht31_t *dev, uint8_t bus_id, uint8_t addr);
float sht31_temperature(sht31_t *dev);
float sht31_humidity(sht31_t *dev);

// ============================================================
// MPU6050 — 6-axis IMU (addr: 0x68/0x69)
// ============================================================
typedef struct {
    uint8_t bus_id, addr;
    float accel_x, accel_y, accel_z;  // g
    float gyro_x, gyro_y, gyro_z;    // °/s
    float temperature;                // °C
} mpu6050_t;

volt_error_t mpu6050_init(mpu6050_t *dev, uint8_t bus_id, uint8_t addr);
float mpu6050_accel_x(mpu6050_t *dev);
float mpu6050_accel_y(mpu6050_t *dev);
float mpu6050_accel_z(mpu6050_t *dev);
float mpu6050_gyro_x(mpu6050_t *dev);
float mpu6050_gyro_y(mpu6050_t *dev);
float mpu6050_gyro_z(mpu6050_t *dev);
float mpu6050_temperature(mpu6050_t *dev);

// ============================================================
// INA219 — Current/Voltage/Power monitor (addr: 0x40-0x4F)
// ============================================================
typedef struct {
    uint8_t bus_id, addr;
    float current_lsb;  // amps per bit (set during calibration)
} ina219_t;

volt_error_t ina219_init(ina219_t *dev, uint8_t bus_id, uint8_t addr);
float ina219_voltage(ina219_t *dev);      // bus voltage (V)
float ina219_current(ina219_t *dev);      // current (A)
float ina219_power(ina219_t *dev);        // power (W)
float ina219_shunt_voltage(ina219_t *dev); // shunt voltage (V)

// ============================================================
// DS3231 — Real-Time Clock (addr: 0x68)
// ============================================================
typedef struct {
    uint8_t bus_id, addr;
    int seconds, minutes, hours;
    int day, date, month, year;
} ds3231_t;

volt_error_t ds3231_init(ds3231_t *dev, uint8_t bus_id, uint8_t addr);
void ds3231_read_time(ds3231_t *dev);
void ds3231_set_time(ds3231_t *dev, int year, int month, int date,
                     int hours, int minutes, int seconds);
float ds3231_temperature(ds3231_t *dev);
int ds3231_hours(ds3231_t *dev);
int ds3231_minutes(ds3231_t *dev);
int ds3231_seconds(ds3231_t *dev);
int ds3231_year(ds3231_t *dev);
int ds3231_month(ds3231_t *dev);
int ds3231_date(ds3231_t *dev);

// ============================================================
// BH1750 — Light Sensor (addr: 0x23/0x5C)
// ============================================================
typedef struct {
    uint8_t bus_id, addr;
} bh1750_t;

volt_error_t bh1750_init(bh1750_t *dev, uint8_t bus_id, uint8_t addr);
float bh1750_lux(bh1750_t *dev);

// ============================================================
// VEML7700 — High-accuracy Light Sensor (addr: 0x10)
// ============================================================
typedef struct {
    uint8_t bus_id, addr;
} veml7700_t;

volt_error_t veml7700_init(veml7700_t *dev, uint8_t bus_id, uint8_t addr);
float veml7700_lux(veml7700_t *dev);
float veml7700_white(veml7700_t *dev);

// ============================================================
// SSD1306 — OLED Display 128x64 (addr: 0x3C/0x3D)
// ============================================================
typedef struct {
    uint8_t bus_id, addr;
    uint8_t buffer[1024];
} ssd1306_t;

volt_error_t ssd1306_init(ssd1306_t *dev, uint8_t bus_id, uint8_t addr);
void ssd1306_clear(ssd1306_t *dev);
void ssd1306_text(ssd1306_t *dev, int x, int y, const char *text);
void ssd1306_show(ssd1306_t *dev);

#endif // VOLT_SENSOR_H
