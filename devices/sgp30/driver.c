/* SGP30 TVOC / eCO2 gas sensor (Sensirion, I2C 0x58) */

#include "volt/sensor.h"
#include "volt/i2c.h"
#include "volt/log.h"
#include "volt/task.h"
#include <math.h>

#define SGP30_IAQ_INIT      0x2003
#define SGP30_MEASURE_IAQ   0x2008
#define SGP30_GET_BASELINE  0x2015
#define SGP30_SET_BASELINE  0x201E
#define SGP30_SET_HUMIDITY  0x2061

#define SGP30_PERIOD_US     1000000ULL
#define SGP30_WARMUP_US     15000000ULL

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

/* Send a 16-bit command followed by n data words (each with CRC). */
static volt_error_t cmd(sgp30_t *dev, uint16_t c, const uint16_t *words, int n)
{
    uint8_t buf[2 + 2 * 3];
    int len = 0;
    buf[len++] = (uint8_t)(c >> 8);
    buf[len++] = (uint8_t)c;
    for (int i = 0; i < n; i++) {
        buf[len++] = (uint8_t)(words[i] >> 8);
        buf[len++] = (uint8_t)words[i];
        buf[len] = crc8(&buf[len - 2], 2);
        len++;
    }
    return volt_i2c_write(dev->bus_id, dev->addr, buf, (uint8_t)len);
}

/* Read n words, checking each CRC. */
static volt_error_t read_words(sgp30_t *dev, uint16_t *out, int n)
{
    uint8_t buf[6];
    volt_error_t err = volt_i2c_read(dev->bus_id, dev->addr, buf, (uint8_t)(n * 3));
    if (err != VOLT_OK) return err;
    for (int i = 0; i < n; i++) {
        if (crc8(&buf[i * 3], 2) != buf[i * 3 + 2]) return VOLT_ERR_INTERNAL;
        out[i] = (uint16_t)((buf[i * 3] << 8) | buf[i * 3 + 1]);
    }
    return VOLT_OK;
}

volt_error_t sgp30_init(sgp30_t *dev, uint8_t bus_id, uint8_t addr)
{
    dev->bus_id = bus_id;
    dev->addr = addr ? addr : 0x58;
    dev->eco2 = 400;
    dev->tvoc = 0;
    dev->ok = false;

    volt_error_t err = cmd(dev, SGP30_IAQ_INIT, 0, 0);
    if (err != VOLT_OK) {
        log_error("sgp30", "no answer at 0x%02X", dev->addr);
        return err;
    }
    volt_delay_ms(10);
    dev->start_us = volt_tick_us();
    dev->last_us = 0;
    log_info("sgp30", "initialized at bus %d addr 0x%02X", bus_id, dev->addr);
    return VOLT_OK;
}

/* Measure at most once per second, as the on-chip algorithm expects. */
static void refresh(sgp30_t *dev)
{
    uint64_t now = volt_tick_us();
    if (dev->last_us && now - dev->last_us < SGP30_PERIOD_US) return;
    dev->last_us = now;

    uint16_t w[2];
    if (cmd(dev, SGP30_MEASURE_IAQ, 0, 0) != VOLT_OK) { dev->ok = false; return; }
    volt_delay_ms(12);
    if (read_words(dev, w, 2) != VOLT_OK) { dev->ok = false; return; }
    dev->eco2 = w[0];
    dev->tvoc = w[1];
    dev->ok = true;
}

int32_t sgp30_eco2(sgp30_t *dev)
{
    refresh(dev);
    return dev->eco2;
}

int32_t sgp30_tvoc(sgp30_t *dev)
{
    refresh(dev);
    return dev->tvoc;
}

bool sgp30_ready(sgp30_t *dev)
{
    refresh(dev);
    return dev->ok && volt_tick_us() - dev->start_us >= SGP30_WARMUP_US;
}

void sgp30_set_humidity(sgp30_t *dev, float temp_c, float rh)
{
    /* Absolute humidity in g/m^3 (Magnus formula), sent as 8.8 fixed point. */
    float ah = 216.7f * ((rh / 100.0f) * 6.112f * expf(17.62f * temp_c / (243.12f + temp_c))
                         / (273.15f + temp_c));
    if (ah < 0.0f) ah = 0.0f;
    if (ah > 255.0f) ah = 255.0f;
    uint16_t v = (uint16_t)(ah * 256.0f + 0.5f);
    if (v == 0) v = 1;   /* 0 would switch compensation off */
    cmd(dev, SGP30_SET_HUMIDITY, &v, 1);
    volt_delay_ms(10);
}

static bool get_baseline(sgp30_t *dev, uint16_t *w)
{
    if (cmd(dev, SGP30_GET_BASELINE, 0, 0) != VOLT_OK) return false;
    volt_delay_ms(10);
    return read_words(dev, w, 2) == VOLT_OK;
}

int32_t sgp30_baseline_eco2(sgp30_t *dev)
{
    uint16_t w[2];
    return get_baseline(dev, w) ? w[0] : -1;
}

int32_t sgp30_baseline_tvoc(sgp30_t *dev)
{
    uint16_t w[2];
    return get_baseline(dev, w) ? w[1] : -1;
}

void sgp30_set_baseline(sgp30_t *dev, int32_t eco2, int32_t tvoc)
{
    if (eco2 <= 0 || tvoc <= 0) return;   /* nothing saved yet */
    uint16_t w[2] = { (uint16_t)tvoc, (uint16_t)eco2 };   /* TVOC first */
    cmd(dev, SGP30_SET_BASELINE, w, 2);
    volt_delay_ms(10);
}
