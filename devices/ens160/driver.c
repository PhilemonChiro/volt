/* ENS160 digital metal-oxide gas sensor (ScioSense, I2C 0x53 / 0x52) */

#include "volt/sensor.h"
#include "volt/i2c.h"
#include "volt/log.h"
#include "volt/task.h"

#define ENS160_PART_ID     0x00
#define ENS160_OPMODE      0x10
#define ENS160_TEMP_IN     0x13
#define ENS160_STATUS      0x20
#define ENS160_DATA_AQI    0x21
#define ENS160_DATA_TVOC   0x22
#define ENS160_DATA_ECO2   0x24

#define ENS160_MODE_IDLE     0x01
#define ENS160_MODE_STANDARD 0x02
#define ENS160_MODE_RESET    0xF0

static volt_error_t rd(ens160_t *dev, uint8_t reg, uint8_t *buf, uint8_t n)
{
    return volt_i2c_write_read(dev->bus_id, dev->addr, &reg, 1, buf, n);
}

static volt_error_t wr(ens160_t *dev, uint8_t reg, const uint8_t *data, uint8_t n)
{
    uint8_t buf[5];
    buf[0] = reg;
    for (uint8_t i = 0; i < n; i++) buf[1 + i] = data[i];
    return volt_i2c_write(dev->bus_id, dev->addr, buf, (uint8_t)(n + 1));
}

static volt_error_t set_mode(ens160_t *dev, uint8_t mode)
{
    return wr(dev, ENS160_OPMODE, &mode, 1);
}

volt_error_t ens160_init(ens160_t *dev, uint8_t bus_id, uint8_t addr)
{
    dev->bus_id = bus_id;
    dev->addr = addr ? addr : 0x53;

    uint8_t id[2];
    volt_error_t err = rd(dev, ENS160_PART_ID, id, 2);
    if (err != VOLT_OK) {
        log_error("ens160", "no answer at 0x%02X", dev->addr);
        return err;
    }
    if ((id[0] | (id[1] << 8)) != 0x0160)
        log_warn("ens160", "unexpected part id 0x%02X%02X", id[1], id[0]);

    set_mode(dev, ENS160_MODE_RESET);
    volt_delay_ms(10);
    set_mode(dev, ENS160_MODE_IDLE);
    volt_delay_ms(10);
    err = set_mode(dev, ENS160_MODE_STANDARD);
    volt_delay_ms(10);
    log_info("ens160", "initialized at bus %d addr 0x%02X", bus_id, dev->addr);
    return err;
}

int32_t ens160_aqi(ens160_t *dev)
{
    uint8_t v;
    if (rd(dev, ENS160_DATA_AQI, &v, 1) != VOLT_OK) return 0;
    return v & 0x07;
}

int32_t ens160_tvoc(ens160_t *dev)
{
    uint8_t b[2];
    if (rd(dev, ENS160_DATA_TVOC, b, 2) != VOLT_OK) return 0;
    return b[0] | (b[1] << 8);
}

int32_t ens160_eco2(ens160_t *dev)
{
    uint8_t b[2];
    if (rd(dev, ENS160_DATA_ECO2, b, 2) != VOLT_OK) return 0;
    return b[0] | (b[1] << 8);
}

int32_t ens160_status(ens160_t *dev)
{
    uint8_t s;
    if (rd(dev, ENS160_STATUS, &s, 1) != VOLT_OK) return -1;
    return (s >> 2) & 0x03;
}

bool ens160_ready(ens160_t *dev)
{
    return ens160_status(dev) == 0;
}

void ens160_set_compensation(ens160_t *dev, float temp_c, float rh)
{
    if (rh < 0.0f) rh = 0.0f;
    if (rh > 100.0f) rh = 100.0f;
    uint16_t t = (uint16_t)((temp_c + 273.15f) * 64.0f + 0.5f);   /* Kelvin x 64 */
    uint16_t h = (uint16_t)(rh * 512.0f + 0.5f);                   /* %RH x 512  */
    uint8_t b[4] = { (uint8_t)t, (uint8_t)(t >> 8), (uint8_t)h, (uint8_t)(h >> 8) };
    wr(dev, ENS160_TEMP_IN, b, 4);   /* TEMP_IN 0x13-0x14, RH_IN 0x15-0x16 */
}
