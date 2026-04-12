#include <stdbool.h>
#include <stdint.h>
#include "volt/pin.h"
#include "volt/log.h"
#include "pico/stdlib.h"
#include "hardware/gpio.h"
#include "hardware/adc.h"

static bool adc_initialized = false;

typedef enum {
    PIN_MODE_UNUSED = 0,
    PIN_MODE_OUTPUT,
    PIN_MODE_INPUT,
    PIN_MODE_INPUT_PULLUP,
    PIN_MODE_INPUT_PULLDOWN,
} pin_mode_t;

// RP2040 has GP0-GP29 (30 pins)
#define PIN_COUNT 30
static pin_mode_t pin_modes[PIN_COUNT];
static uint8_t pin_output_state[PIN_COUNT];

// ISR context per pin
typedef struct {
    pin_callback_t callback;
    void *arg;
    uint8_t pin;
} pin_isr_ctx_t;

static volatile pin_isr_ctx_t isr_contexts[PIN_COUNT];

// Single GPIO IRQ handler — dispatches to per-pin callbacks
static void gpio_irq_handler(uint gpio, uint32_t events)
{
    if (gpio < PIN_COUNT && isr_contexts[gpio].callback) {
        isr_contexts[gpio].callback(isr_contexts[gpio].pin, isr_contexts[gpio].arg);
    }
}

static bool is_valid_pin(uint8_t pin)
{
    if (pin >= PIN_COUNT) return false;
    if (pin == 29) return false; // GP29 = internal VSYS voltage divider
    return true;
}

volt_error_t pin_set_output(uint8_t pin)
{
    if (!is_valid_pin(pin)) return VOLT_ERR_INVALID_PIN;
    if (pin_modes[pin] != PIN_MODE_UNUSED) return VOLT_ERR_PIN_IN_USE;

    gpio_init(pin);
    gpio_set_dir(pin, GPIO_OUT);
    pin_modes[pin] = PIN_MODE_OUTPUT;
    return VOLT_OK;
}

volt_error_t pin_set_input(uint8_t pin)
{
    if (!is_valid_pin(pin)) return VOLT_ERR_INVALID_PIN;
    if (pin_modes[pin] != PIN_MODE_UNUSED) return VOLT_ERR_PIN_IN_USE;

    gpio_init(pin);
    gpio_set_dir(pin, GPIO_IN);
    gpio_disable_pulls(pin);
    pin_modes[pin] = PIN_MODE_INPUT;
    return VOLT_OK;
}

volt_error_t pin_set_input_pullup(uint8_t pin)
{
    if (!is_valid_pin(pin)) return VOLT_ERR_INVALID_PIN;
    if (pin_modes[pin] != PIN_MODE_UNUSED) return VOLT_ERR_PIN_IN_USE;

    gpio_init(pin);
    gpio_set_dir(pin, GPIO_IN);
    gpio_pull_up(pin);
    pin_modes[pin] = PIN_MODE_INPUT_PULLUP;
    return VOLT_OK;
}

volt_error_t pin_set_input_pulldown(uint8_t pin)
{
    if (!is_valid_pin(pin)) return VOLT_ERR_INVALID_PIN;
    if (pin_modes[pin] != PIN_MODE_UNUSED) return VOLT_ERR_PIN_IN_USE;

    gpio_init(pin);
    gpio_set_dir(pin, GPIO_IN);
    gpio_pull_down(pin);
    pin_modes[pin] = PIN_MODE_INPUT_PULLDOWN;
    return VOLT_OK;
}

volt_error_t pin_write(uint8_t pin, uint8_t level)
{
    if (pin >= PIN_COUNT) return VOLT_ERR_INVALID_PIN;
    if (pin_modes[pin] != PIN_MODE_OUTPUT) return VOLT_ERR_WRONG_PIN_MODE;

    uint8_t val = level ? 1 : 0;
    gpio_put(pin, val);
    pin_output_state[pin] = val;
    return VOLT_OK;
}

volt_error_t pin_toggle(uint8_t pin)
{
    if (pin >= PIN_COUNT) return VOLT_ERR_INVALID_PIN;
    if (pin_modes[pin] != PIN_MODE_OUTPUT) return VOLT_ERR_WRONG_PIN_MODE;

    pin_output_state[pin] = !pin_output_state[pin];
    gpio_put(pin, pin_output_state[pin]);
    return VOLT_OK;
}

int pin_read(uint8_t pin)
{
    if (pin >= PIN_COUNT) return LOW;

    // ADC read for analog pins GP26-GP28
    if (pin >= 26 && pin <= 28 && pin_modes[pin] == PIN_MODE_INPUT) {
        if (!adc_initialized) {
            adc_init();
            adc_initialized = true;
        }
        adc_gpio_init(pin);
        adc_select_input(pin - 26);
        return adc_read(); // 12-bit: 0-4095
    }

    return gpio_get(pin) ? HIGH : LOW;
}

volt_error_t pin_on_change(uint8_t pin, pin_callback_t callback, void *arg)
{
    if (!is_valid_pin(pin)) return VOLT_ERR_INVALID_PIN;

    isr_contexts[pin].callback = callback;
    isr_contexts[pin].arg = arg;
    isr_contexts[pin].pin = pin;

    gpio_set_irq_enabled_with_callback(pin, GPIO_IRQ_EDGE_RISE | GPIO_IRQ_EDGE_FALL,
                                       true, gpio_irq_handler);
    return VOLT_OK;
}

volt_error_t pin_release(uint8_t pin)
{
    if (pin >= PIN_COUNT) return VOLT_ERR_INVALID_PIN;
    if (pin_modes[pin] == PIN_MODE_UNUSED) return VOLT_OK;

    gpio_set_irq_enabled(pin, GPIO_IRQ_EDGE_RISE | GPIO_IRQ_EDGE_FALL, false);
    isr_contexts[pin].callback = NULL;
    gpio_deinit(pin);
    pin_modes[pin] = PIN_MODE_UNUSED;
    return VOLT_OK;
}

void pin_blink(uint8_t pin, uint32_t interval_ms)
{
    pin_toggle(pin);
    sleep_ms(interval_ms);
    pin_toggle(pin);
}

void pin_blink_once(uint8_t pin, uint32_t duration_ms)
{
    pin_write(pin, HIGH);
    sleep_ms(duration_ms);
    pin_write(pin, LOW);
}
