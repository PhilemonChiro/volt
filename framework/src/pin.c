#include <stdbool.h>
#include <stdint.h>
#include "volt/pin.h"
#include "volt/log.h"
#include "driver/gpio.h"
#include "esp_attr.h"

// Track the mode of each pin so we can validate operations
typedef enum {
    PIN_MODE_UNUSED = 0,
    PIN_MODE_OUTPUT,
    PIN_MODE_INPUT,
    PIN_MODE_INPUT_PULLUP,
    PIN_MODE_INPUT_PULLDOWN,
} pin_mode_t;

// ESP32 has GPIO 0-39 (40 pins total)
#define PIN_COUNT 40
static pin_mode_t pin_modes[PIN_COUNT];

// Track output state ourselves — gpio_get_level() reads the INPUT register
// which may not reflect the output on all ESP32 pins/revisions.
static uint8_t pin_output_state[PIN_COUNT];

// Whether the GPIO ISR service has been installed (one-time init)
static bool isr_service_installed = false;

// ISR wrapper: ESP-IDF gives us (void *arg), but our callback wants (pin, arg).
// We store the pin number and user callback in a small struct per pin.
typedef struct {
    pin_callback_t callback;
    void *arg;
    uint8_t pin;
} pin_isr_ctx_t;

// volatile: ISR reads these from interrupt context on a different core
static volatile pin_isr_ctx_t isr_contexts[PIN_COUNT];

// This is the actual ISR that ESP-IDF calls — it unpacks and calls the user's callback
static void IRAM_ATTR pin_isr_wrapper(void *arg)
{
    volatile pin_isr_ctx_t *ctx = (volatile pin_isr_ctx_t *)arg;
    ctx->callback(ctx->pin, ctx->arg);
}

// Returns false for pins that would crash the chip if reconfigured
static bool is_valid_pin(uint8_t pin)
{
    if (pin >= PIN_COUNT) return false;

    // GPIO 6-11 are connected to SPI flash — never touch these
    if (pin >= 6 && pin <= 11) return false;

    return true;
}

// Returns false for pins that cannot be used as output (input-only pins)
static bool can_output(uint8_t pin)
{
    // GPIO 34-39 are input-only — no output driver in hardware
    return pin <= 33;
}

// Internal helper: configure a pin with ESP-IDF
static volt_error_t pin_configure(uint8_t pin, gpio_mode_t mode,
                                  bool pullup, bool pulldown)
{
    if (!is_valid_pin(pin)) {
        log_error("pin", "GPIO %d is invalid or reserved for flash", pin);
        return VOLT_ERR_INVALID_PIN;
    }

    if (pin_modes[pin] != PIN_MODE_UNUSED) {
        log_error("pin", "GPIO %d is already in use", pin);
        return VOLT_ERR_PIN_IN_USE;
    }

    gpio_config_t cfg = {
        .pin_bit_mask = (1ULL << pin),
        .mode = mode,
        .pull_up_en = pullup ? GPIO_PULLUP_ENABLE : GPIO_PULLUP_DISABLE,
        .pull_down_en = pulldown ? GPIO_PULLDOWN_ENABLE : GPIO_PULLDOWN_DISABLE,
        .intr_type = GPIO_INTR_DISABLE,
    };

    esp_err_t err = gpio_config(&cfg);
    if (err != ESP_OK) {
        log_error("pin", "GPIO %d config failed (esp_err=%d)", pin, err);
        return VOLT_ERR_PIN_CONFIG_FAILED;
    }

    return VOLT_OK;
}

volt_error_t pin_set_output(uint8_t pin)
{
    if (!can_output(pin)) {
        log_error("pin", "GPIO %d is input-only, cannot be output", pin);
        return VOLT_ERR_INVALID_PIN;
    }

    volt_error_t result = pin_configure(pin, GPIO_MODE_OUTPUT, false, false);
    if (result == VOLT_OK) {
        pin_modes[pin] = PIN_MODE_OUTPUT;
        log_debug("pin", "GPIO %d configured as output", pin);
    }
    return result;
}

volt_error_t pin_set_input(uint8_t pin)
{
    volt_error_t result = pin_configure(pin, GPIO_MODE_INPUT, false, false);
    if (result == VOLT_OK) {
        pin_modes[pin] = PIN_MODE_INPUT;
        log_debug("pin", "GPIO %d configured as input", pin);
    }
    return result;
}

volt_error_t pin_set_input_pullup(uint8_t pin)
{
    // GPIO 34-39 have no internal pull resistors
    if (pin >= 34) {
        log_error("pin", "GPIO %d has no internal pull-up (input-only pin)", pin);
        return VOLT_ERR_NOT_SUPPORTED;
    }

    volt_error_t result = pin_configure(pin, GPIO_MODE_INPUT, true, false);
    if (result == VOLT_OK) {
        pin_modes[pin] = PIN_MODE_INPUT_PULLUP;
        log_debug("pin", "GPIO %d configured as input with pull-up", pin);
    }
    return result;
}

volt_error_t pin_set_input_pulldown(uint8_t pin)
{
    // GPIO 34-39 have no internal pull resistors
    if (pin >= 34) {
        log_error("pin", "GPIO %d has no internal pull-down (input-only pin)", pin);
        return VOLT_ERR_NOT_SUPPORTED;
    }

    volt_error_t result = pin_configure(pin, GPIO_MODE_INPUT, false, true);
    if (result == VOLT_OK) {
        pin_modes[pin] = PIN_MODE_INPUT_PULLDOWN;
        log_debug("pin", "GPIO %d configured as input with pull-down", pin);
    }
    return result;
}

volt_error_t pin_write(uint8_t pin, uint8_t level)
{
    if (pin >= PIN_COUNT) return VOLT_ERR_INVALID_PIN;

    if (pin_modes[pin] != PIN_MODE_OUTPUT) {
        log_error("pin", "GPIO %d is not configured as output", pin);
        return VOLT_ERR_WRONG_PIN_MODE;
    }

    uint8_t val = level ? 1 : 0;
    gpio_set_level(pin, val);
    pin_output_state[pin] = val;
    return VOLT_OK;
}

volt_error_t pin_toggle(uint8_t pin)
{
    if (pin >= PIN_COUNT) return VOLT_ERR_INVALID_PIN;

    if (pin_modes[pin] != PIN_MODE_OUTPUT) {
        log_error("pin", "GPIO %d is not configured as output", pin);
        return VOLT_ERR_WRONG_PIN_MODE;
    }

    // Use tracked state — gpio_get_level reads INPUT register which
    // doesn't reflect output state on output-only configured pins.
    pin_output_state[pin] = !pin_output_state[pin];
    gpio_set_level(pin, pin_output_state[pin]);
    return VOLT_OK;
}

int pin_read(uint8_t pin)
{
    if (pin >= PIN_COUNT) return LOW;
    return gpio_get_level(pin);
}

volt_error_t pin_on_change(uint8_t pin, pin_callback_t callback, void *arg)
{
    if (!is_valid_pin(pin)) return VOLT_ERR_INVALID_PIN;

    // Install the GPIO ISR service once on first use
    if (!isr_service_installed) {
        esp_err_t err = gpio_install_isr_service(0);
        if (err != ESP_OK && err != ESP_ERR_INVALID_STATE) {
            // ESP_ERR_INVALID_STATE means already installed — that's fine
            log_error("pin", "ISR service install failed (esp_err=%d)", err);
            return VOLT_ERR_PIN_CONFIG_FAILED;
        }
        isr_service_installed = true;
    }

    // Store the user's callback and pin number in the context
    isr_contexts[pin].callback = callback;
    isr_contexts[pin].arg = arg;
    isr_contexts[pin].pin = pin;

    // Enable interrupts on both edges (rising and falling)
    gpio_set_intr_type(pin, GPIO_INTR_ANYEDGE);
    esp_err_t err = gpio_isr_handler_add(pin, pin_isr_wrapper, &isr_contexts[pin]);
    if (err != ESP_OK) {
        log_error("pin", "GPIO %d ISR handler add failed (esp_err=%d)", pin, err);
        return VOLT_ERR_PIN_CONFIG_FAILED;
    }

    log_debug("pin", "GPIO %d interrupt handler registered", pin);
    return VOLT_OK;
}

volt_error_t pin_release(uint8_t pin)
{
    if (pin >= PIN_COUNT) return VOLT_ERR_INVALID_PIN;

    if (pin_modes[pin] == PIN_MODE_UNUSED) {
        return VOLT_OK;  // already unused, nothing to do
    }

    // Remove ISR handler if any
    gpio_isr_handler_remove(pin);

    // Reset pin to default state (ESP32 only — ESP8266 doesn't have gpio_reset_pin)
#ifdef CONFIG_IDF_TARGET_ESP32
    gpio_reset_pin(pin);
#endif

    pin_modes[pin] = PIN_MODE_UNUSED;
    log_debug("pin", "GPIO %d released", pin);
    return VOLT_OK;
}

void pin_blink(uint8_t pin, uint32_t interval_ms)
{
    pin_toggle(pin);
    vTaskDelay(interval_ms / portTICK_PERIOD_MS);
    pin_toggle(pin);
}

void pin_blink_once(uint8_t pin, uint32_t duration_ms)
{
    pin_write(pin, HIGH);
    vTaskDelay(duration_ms / portTICK_PERIOD_MS);
    pin_write(pin, LOW);
}
