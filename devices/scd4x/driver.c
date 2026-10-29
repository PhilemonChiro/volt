/* SCD40 / SCD41 photoacoustic CO2 sensor (Sensirion, I2C 0x62) */

#include "volt/sensor.h"
#include "volt/i2c.h"
#include "volt/log.h"
#include "volt/task.h"

#define SCD4X_START_PERIODIC   0x21B1
#define SCD4X_STOP_PERIODIC    0x3F86
#define SCD4X_READ_MEASUREMENT 0xEC05
#define SCD4X_DATA_READY       0xE4B8
#define SCD4X_SET_PRESSURE     0xE000
#define SCD4X_SET_TEMP_OFFSET  0x241D
#define SCD4X_SET_ASC          0x2416
#define SCD4X_FORCED_RECAL     0x362F

static uint8_t crc8(const uint8_t *d, int n)
{
    uint8_t crc = 0xFF;
    for (int i = 0; i < n; i++) {
        crc ^= d[i];
        for (int b = 0; b < 8; b++)
            crc = (crc & 0x80) ? (uint8_t)((crc << 1) ^ 0x31) : (uint8_t)(crc << 1);
    }
    return crc;
}

/* Send a 16-bit command, optionally followed by one data word with CRC. */
static volt_error_t cmd(scd4x_t *dev, uint16_t c, const uint16_t *word)
{
    uint8_t buf[5] = { (uint8_t)(c >> 8), (uint8_t)c };
    uint8_t len = 2;
    if (word) {
        buf[2] = (uint8_t)(*word >> 8);
        buf[3] = (uint8_t)*word;
        buf[4] = crc8(&buf[2], 2);
        len = 5;
    }
    return volt_i2c_write(dev->bus_id, dev->addr, buf, len);
}

/* Read n words (n <= 3), checking each CRC. */
static volt_error_t read_words(scd4x_t *dev, uint16_t *out, int n)
{
    uint8_t buf[9];
    volt_error_t err = volt_i2c_read(dev->bus_id, dev->addr, buf, (uint8_t)(n * 3));
    if (err != VOLT_OK) return err;
    for (int i = 0; i < n; i++) {
        if (crc8(&buf[i * 3], 2) != buf[i * 3 + 2]) return VOLT_ERR_INTERNAL;
        out[i] = (uint16_t)((buf[i * 3] << 8) | buf[i * 3 + 1]);
    }
    return VOLT_OK;
}

static void stop(scd4x_t *dev)
{
    cmd(dev, SCD4X_STOP_PERIODIC, 0);
    volt_delay_ms(500);
}

static void start(scd4x_t *dev)
{
    cmd(dev, SCD4X_START_PERIODIC, 0);
}

volt_error_t scd4x_init(scd4x_t *dev, uint8_t bus_id, uint8_t addr)
{
    dev->bus_id = bus_id;
    dev->addr = addr ? addr : 0x62;
    dev->co2 = 0;
    dev->temperature = 0.0f;
    dev->humidity = 0.0f;
    dev->has_data = false;

    /* It may still be measuring from before an MCU reset: stop first. */
    volt_error_t err = cmd(dev, SCD4X_STOP_PERIODIC, 0);
    if (err != VOLT_OK) {
        log_error("scd4x", "no answer at 0x%02X", dev->addr);
        return err;
    }
    volt_delay_ms(500);
    err = cmd(dev, SCD4X_START_PERIODIC, 0);
    log_info("scd4x", "initialized at bus %d addr 0x%02X", bus_id, dev->addr);
    return err;
}

/* Fetch a new measurement if one is waiting; otherwise keep the cached one. */
static void refresh(scd4x_t *dev)
{
    uint16_t w[3];
    if (cmd(dev, SCD4X_DATA_READY, 0) != VOLT_OK) return;
    volt_delay_ms(1);
    if (read_words(dev, w, 1) != VOLT_OK || (w[0] & 0x07FF) == 0) return;

    if (cmd(dev, SCD4X_READ_MEASUREMENT, 0) != VOLT_OK) return;
    volt_delay_ms(1);
    if (read_words(dev, w, 3) != VOLT_OK) return;
    dev->co2 = w[0];
    dev->temperature = -45.0f + 175.0f * (float)w[1] / 65535.0f;
    dev->humidity = 100.0f * (float)w[2] / 65535.0f;
    dev->has_data = true;
}

int32_t scd4x_co2(scd4x_t *dev)
{
    refresh(dev);
    return dev->co2;
}

float scd4x_temperature(scd4x_t *dev)
{
    refresh(dev);
    return dev->temperature;
}

float scd4x_humidity(scd4x_t *dev)
{
    refresh(dev);
    return dev->humidity;
}

bool scd4x_ready(scd4x_t *dev)
{
    refresh(dev);
    return dev->has_data;
}

void scd4x_set_pressure(scd4x_t *dev, int32_t hpa)
{
    if (hpa < 700 || hpa > 1200) return;
    uint16_t w = (uint16_t)hpa;
    cmd(dev, SCD4X_SET_PRESSURE, &w);
    volt_delay_ms(1);
}

void scd4x_set_temperature_offset(scd4x_t *dev, float offset)
{
    if (offset < 0.0f) offset = 0.0f;
    if (offset > 20.0f) offset = 20.0f;
    uint16_t w = (uint16_t)(offset * 65536.0f / 175.0f + 0.5f);
    stop(dev);
    cmd(dev, SCD4X_SET_TEMP_OFFSET, &w);
    volt_delay_ms(1);
    start(dev);
}

void scd4x_set_auto_calibration(scd4x_t *dev, bool on)
{
    uint16_t w = on ? 1 : 0;
    stop(dev);
    cmd(dev, SCD4X_SET_ASC, &w);
    volt_delay_ms(1);
    start(dev);
}

int32_t scd4x_calibrate(scd4x_t *dev, int32_t target_ppm)
{
    if (target_ppm < 300 || target_ppm > 2000) return -32768;
    uint16_t w = (uint16_t)target_ppm;
    uint16_t r = 0xFFFF;
    stop(dev);
    if (cmd(dev, SCD4X_FORCED_RECAL, &w) == VOLT_OK) {
        volt_delay_ms(400);
        if (read_words(dev, &r, 1) != VOLT_OK) r = 0xFFFF;
    }
    start(dev);
    if (r == 0xFFFF) {
        log_warn("scd4x", "forced recalibration failed");
        return -32768;
    }
    return (int32_t)r - 0x8000;
}
