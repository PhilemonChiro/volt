/* DS18B20 1-Wire thermometer, bit-banged on one GPIO.
   The bus idles high through a 4.7k pull-up; the driver only ever pulls it
   low (output, write 0) or lets go (input), never drives it high. */

#include "volt/pin.h"
#include "volt/task.h"
#include "volt/log.h"
#include <stdint.h>
#include <stdbool.h>

#define CONVERT_MS 750   // 12-bit conversion time (datasheet max)
#define STALE_MS   2000  // a finished conversion older than this is re-done
#define READ_TRIES 3     // re-read the scratchpad on a CRC error

#define CMD_SKIP_ROM        0xCC  // one sensor on the pin: address it without its ROM code
#define CMD_CONVERT         0x44
#define CMD_READ_SCRATCHPAD 0xBE
#define POWER_ON_RAW        0x0550  // 85.0 °C: the value before any conversion ran

// Slot timings are measured from the falling edge, so the time pin
// direction changes take is absorbed instead of added.
static void wait_until(uint64_t t) { while (volt_tick_us() < t) { } }
static void bus_low(uint8_t g) { pin_set_output(g); pin_write(g, 0); }
static void bus_release(uint8_t g) { pin_set_input_pullup(g); }  // internal pull-up only backs up the 4.7k

// Reset pulse; true if a sensor answered with a presence pulse.
static bool bus_reset(uint8_t g)
{
    bus_release(g);
    if (pin_read(g) == 0) return false;   // held low: no pull-up, or shorted
    uint64_t t0 = volt_tick_us();
    bus_low(g);
    wait_until(t0 + 480);
    bus_release(g);
    wait_until(t0 + 480 + 70);
    bool present = pin_read(g) == 0;
    wait_until(t0 + 480 + 480);
    return present;
}

static void write_bit(uint8_t g, int bit)
{
    uint64_t t0 = volt_tick_us();
    bus_low(g);
    wait_until(t0 + (bit ? 6 : 60));
    bus_release(g);
    wait_until(t0 + 70);
}

static int read_bit(uint8_t g)
{
    uint64_t t0 = volt_tick_us();
    bus_low(g);
    wait_until(t0 + 3);
    bus_release(g);
    wait_until(t0 + 12);              // the sensor's 0 is valid until 15 us
    int bit = pin_read(g);
    wait_until(t0 + 70);
    return bit;
}

static void write_byte(uint8_t g, uint8_t b)
{
    for (int i = 0; i < 8; i++) write_bit(g, (b >> i) & 1);   // LSB first
}

static uint8_t read_byte(uint8_t g)
{
    uint8_t b = 0;
    for (int i = 0; i < 8; i++) b |= (uint8_t)(read_bit(g) << i);
    return b;
}

// Dallas/Maxim CRC-8 (x^8 + x^5 + x^4 + 1, reflected).
static uint8_t crc8(const uint8_t *data, int n)
{
    uint8_t crc = 0;
    for (int i = 0; i < n; i++) {
        uint8_t b = data[i];
        for (int j = 0; j < 8; j++) {
            uint8_t mix = (crc ^ b) & 1;
            crc >>= 1;
            if (mix) crc ^= 0x8C;
            b >>= 1;
        }
    }
    return crc;
}

static bool start_conversion(ds18b20_t *dev)
{
    if (!bus_reset(dev->gpio)) return false;
    write_byte(dev->gpio, CMD_SKIP_ROM);
    write_byte(dev->gpio, CMD_CONVERT);
    dev->converting = true;
    dev->started_ms = volt_tick_ms();
    return true;
}

// Read the result; false on no answer, a CRC error or the power-on value.
static bool read_result(ds18b20_t *dev, float *celsius)
{
    for (int attempt = 0; attempt < READ_TRIES; attempt++) {
        if (!bus_reset(dev->gpio)) return false;
        write_byte(dev->gpio, CMD_SKIP_ROM);
        write_byte(dev->gpio, CMD_READ_SCRATCHPAD);
        uint8_t pad[9];
        bool all_zero = true;
        for (int i = 0; i < 9; i++) {
            pad[i] = read_byte(dev->gpio);
            if (pad[i]) all_zero = false;
        }
        if (all_zero || crc8(pad, 8) != pad[8]) continue;   // a glitched slot: read again
        int16_t raw = (int16_t)(((uint16_t)pad[1] << 8) | pad[0]);
        if (raw == POWER_ON_RAW) return false;
        *celsius = raw / 16.0f;
        return true;
    }
    return false;
}

volt_error_t ds18b20_init(ds18b20_t *dev, uint8_t gpio)
{
    dev->gpio = gpio;
    dev->celsius = 0;
    dev->connected = false;
    dev->converting = false;
    dev->started_ms = 0;
    bus_release(gpio);
    if (!bus_reset(gpio)) log_warn("ds18b20", "no sensor answered on GPIO %d (check the 4.7k pull-up)", gpio);
    else log_info("ds18b20", "DS18B20 on GPIO %d", gpio);
    return VOLT_OK;
}

// A conversion takes 750 ms, so each call reads the one the previous call
// started and starts the next. When there is none, or it is older than
// STALE_MS, the call starts one and waits for it, so a reading is never
// more than 2 s old.
float ds18b20_temperature(ds18b20_t *dev)
{
    uint32_t age = volt_tick_ms() - dev->started_ms;
    if (!dev->converting || age > STALE_MS) {
        if (!start_conversion(dev)) {
            dev->connected = false;
            return dev->celsius;
        }
        age = 0;
    }
    if (age < CONVERT_MS) volt_delay_ms(CONVERT_MS - age);
    dev->converting = false;

    float c;
    dev->connected = read_result(dev, &c);
    if (dev->connected) dev->celsius = c;
    start_conversion(dev);
    return dev->celsius;
}

bool ds18b20_is_connected(ds18b20_t *dev)
{
    return dev->connected;
}
