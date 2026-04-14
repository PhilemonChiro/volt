#ifndef VOLT_PIN_H
#define VOLT_PIN_H

#include <stdint.h>
#include "volt/error.h"

// Output levels
#define HIGH 1
#define LOW  0

// Configure a pin as output. Must call before pin_write() or pin_toggle().
volt_error_t pin_set_output(uint8_t pin);

// Configure a pin as input (floating — no pull resistor).
volt_error_t pin_set_input(uint8_t pin);

// Configure a pin as input with internal pull-up resistor.
// Reads HIGH when nothing is connected, LOW when grounded.
// Use for buttons that connect to GND when pressed.
volt_error_t pin_set_input_pullup(uint8_t pin);

// Configure a pin as input with internal pull-down resistor.
// Reads LOW when nothing is connected, HIGH when connected to 3.3V.
volt_error_t pin_set_input_pulldown(uint8_t pin);

// Set an output pin HIGH or LOW. Returns error if pin is not output.
volt_error_t pin_write(uint8_t pin, uint8_t level);

// Flip an output pin: HIGH becomes LOW, LOW becomes HIGH.
// Returns error if pin is not output.
volt_error_t pin_toggle(uint8_t pin);

// Read the current level of any pin. Returns HIGH (1) or LOW (0).
// Works on both input and output pins.
int pin_read(uint8_t pin);

// Register a callback that fires when a pin changes state.
// The callback runs in ISR context — keep it fast, no printf or malloc.
// Typically used to set a flag that a task checks.
typedef void (*pin_callback_t)(uint8_t pin, void *arg);
volt_error_t pin_on_change(uint8_t pin, pin_callback_t callback, void *arg);

// Release a pin back to unused state. Removes any callbacks.
volt_error_t pin_release(uint8_t pin);

// Configure a pin as PWM output. Default frequency ~1kHz, 8-bit resolution (0-255).
volt_error_t pin_set_pwm(uint8_t pin);

// Set PWM duty cycle (0-255). Pin must be configured with pin_set_pwm().
volt_error_t pin_pwm_write(uint8_t pin, uint8_t duty);

// Play a tone at a specific frequency (Hz). Pin must be PWM.
// Sets 50% duty cycle at the given frequency. 0 = silence.
volt_error_t pin_tone(uint8_t pin, uint32_t frequency_hz);

// Play a tone for a duration then stop.
void pin_tone_ms(uint8_t pin, uint32_t frequency_hz, uint32_t duration_ms);

// Stop any tone playing on this pin (set duty to 0).
void pin_no_tone(uint8_t pin);

// Blink an output pin: toggle, wait interval_ms, toggle back.
// Non-blocking in protothread context (used with yield macros).
// For simple use in main or one-shot code.
void pin_blink(uint8_t pin, uint32_t interval_ms);

// Turn on for duration_ms, then turn off.
void pin_blink_once(uint8_t pin, uint32_t duration_ms);

#endif // VOLT_PIN_H
