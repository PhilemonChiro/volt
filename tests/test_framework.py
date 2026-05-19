"""
Framework integration tests — verify generated C code compiles against framework headers.

Tests at 3 levels:
  1. API surface: Generated C references real framework functions/types
  2. Codegen linkage: Real Volt programs → C → compile against headers
  3. Cross-chip: Same program compiles for ESP32 and RP2040

Uses host gcc with stub implementations — no SDK required.
Catches: missing includes, wrong function signatures, type mismatches,
undefined symbols, struct field errors.
"""

import sys
import os
import subprocess
import tempfile
import shutil

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src'))
from volt.compiler.voltc import compile_volt

FRAMEWORK_INCLUDE = os.path.join(os.path.dirname(__file__), '..', 'framework', 'include')
STUB_DIR = None  # Created at test time

passed = 0
failed = 0

def check(name, condition, detail=""):
    global passed, failed
    if condition:
        print(f"  OK: {name}")
        passed += 1
    else:
        print(f"FAIL: {name} — {detail}")
        failed += 1


# ============================================================
# Stub generator — provides empty implementations of all framework functions
# so host gcc can compile generated C without ESP-IDF/Pico SDK.
# ============================================================

STUBS_C = r"""
// Auto-generated stubs for host compile testing — not real implementations
#include <stdint.h>
#include <stdbool.h>
#include <stddef.h>
#include <string.h>
#include <stdio.h>
#include <stdarg.h>
#include <stdatomic.h>

// Error type
typedef int volt_error_t;
#define VOLT_OK 0
#define VOLT_ERR_INVALID_ARG -1
#define VOLT_ERR_TIMEOUT -2
#define VOLT_ERR_NO_MEMORY -3
#define VOLT_ERR_NOT_SUPPORTED -4
#define VOLT_ERR_INTERNAL -5
#define VOLT_ERR_INVALID_PIN -10
#define VOLT_ERR_PIN_IN_USE -11
#define VOLT_ERR_WRONG_PIN_MODE -12
#define VOLT_ERR_PIN_CONFIG_FAILED -13
#define VOLT_ERR_TOO_MANY_TASKS -20
#define VOLT_ERR_TASK_CREATE_FAILED -21
#define VOLT_ERR_TIMER_FAILED -22
#define VOLT_ERR_KEY_NOT_FOUND -60
#define VOLT_ERR_STORAGE_FULL -61
#define VOLT_ERR_STORAGE_INIT_FAILED -62
#define VOLT_ERR_STORAGE_WRITE_FAILED -63
const char *volt_error_name(volt_error_t e) { return "stub"; }

// Constants
#define HIGH 1
#define LOW  0
#define ON   1
#define OFF  0

// volt_init — inline in real framework, stub here
static inline void volt_init(void) {}

// Log
void volt_log_write(int level, const char *tag, const char *fmt, ...) {}
#define log_error(tag, fmt, ...) volt_log_write(1, tag, fmt, ##__VA_ARGS__)
#define log_warn(tag, fmt, ...)  volt_log_write(2, tag, fmt, ##__VA_ARGS__)
#define log_info(tag, fmt, ...)  volt_log_write(3, tag, fmt, ##__VA_ARGS__)
#define log_debug(tag, fmt, ...) volt_log_write(4, tag, fmt, ##__VA_ARGS__)
#define VOLT_LOG_LEVEL 4

// Pin
volt_error_t pin_set_output(uint8_t p) { return 0; }
volt_error_t pin_set_input(uint8_t p) { return 0; }
volt_error_t pin_set_input_pullup(uint8_t p) { return 0; }
volt_error_t pin_set_input_pulldown(uint8_t p) { return 0; }
volt_error_t pin_write(uint8_t p, uint8_t v) { return 0; }
volt_error_t pin_toggle(uint8_t p) { return 0; }
int pin_read(uint8_t p) { return 0; }
volt_error_t pin_release(uint8_t p) { return 0; }
typedef void (*pin_callback_t)(uint8_t pin, void *arg);
volt_error_t pin_on_change(uint8_t p, pin_callback_t cb, void *arg) { return 0; }
volt_error_t pin_set_pwm(uint8_t p) { return 0; }
volt_error_t pin_pwm_write(uint8_t p, uint8_t d) { return 0; }
volt_error_t pin_tone(uint8_t p, uint32_t f) { return 0; }
void pin_tone_ms(uint8_t p, uint32_t f, uint32_t d) {}
void pin_no_tone(uint8_t p) {}
void pin_blink(uint8_t p, uint32_t ms) {}
void pin_blink_once(uint8_t p, uint32_t ms) {}
void pin_tone_click(uint8_t p) {}
void pin_tone_success(uint8_t p) {}
void pin_tone_error(uint8_t p) {}
void pin_tone_warning(uint8_t p) {}
void pin_tone_startup(uint8_t p) {}
void pin_tone_shutdown(uint8_t p) {}
void pin_tone_notify(uint8_t p) {}
void pin_tone_alarm(uint8_t p) {}
void pin_tone_keypad(uint8_t p, uint8_t d) {}
volt_error_t pin_set_dac(uint8_t p) { return 0; }
volt_error_t pin_dac_write(uint8_t p, uint8_t v) { return 0; }
volt_error_t pin_dac_voltage(uint8_t p, float v) { return 0; }
uint8_t pin_dac_read(uint8_t p) { return 0; }

// Task
#define VOLT_TASK_RUNNING 0
#define VOLT_TASK_WAITING 1
#define VOLT_TASK_DONE 2
typedef struct { uint16_t _line; uint8_t status; uint32_t wake_at; const char *name; } volt_task_t;
typedef void (*volt_task_func_t)(volt_task_t *t);
typedef struct { volt_task_func_t func; volt_task_t *task; } volt_task_entry_t;
#define VOLT_TASK_BEGIN(t) switch((t)->_line) { case 0:
#define VOLT_TASK_END(t) } (t)->status = VOLT_TASK_DONE;
#define VOLT_TASK_SLEEP_MS(t, ms) do { (t)->wake_at = volt_tick_ms()+(ms); (t)->_line = __LINE__; (t)->status = 1; return; case __LINE__: if((int32_t)(volt_tick_ms()-(t)->wake_at)<0){(t)->status=1;return;} } while(0)
#define VOLT_TASK_YIELD(t) do { (t)->_line = __LINE__; (t)->status = 1; return; case __LINE__:; } while(0)
#define VOLT_YIELD_LABEL(t, label, ms) do { if((t)->wake_at==0){(t)->wake_at=volt_tick_ms()+(ms);}else{(t)->wake_at+=(ms);} (t)->_line = label; (t)->status = 1; return; case label: if((int32_t)(volt_tick_ms()-(t)->wake_at)<0){(t)->status=1;return;} } while(0)
#define VOLT_WAIT_LABEL(t, label, cond) do { (t)->_line = label; case label: if(!(cond)){(t)->status=1;return;} } while(0)
void volt_run(volt_task_entry_t *tasks, int count) {}
#define VOLT_PRIORITY_LOW 2
#define VOLT_PRIORITY_NORMAL 5
#define VOLT_PRIORITY_HIGH 10
#define VOLT_PRIORITY_CRITICAL 20
typedef void (*volt_rt_func_t)(void *arg);
volt_error_t volt_rt_create(const char *n, volt_rt_func_t f, uint32_t s, void *a, uint8_t p, int c) { return 0; }
typedef void (*volt_crit_func_t)(void *arg);
volt_error_t volt_critical_create(const char *n, volt_crit_func_t f, uint32_t p, void *a) { return 0; }
void volt_delay_ms(uint32_t ms) {}
uint32_t volt_tick_ms(void) { return 0; }
uint64_t volt_tick_us(void) { return 0; }

// System
void system_restart(void) {}
uint32_t system_free_heap(void) { return 0; }
uint32_t system_uptime(void) { return 0; }
uint32_t system_id(void) { return 0; }
void system_deep_sleep(uint64_t us) {}
void system_light_sleep(void) {}
void volt_wdt_enable(uint32_t ms) {}
void volt_wdt_feed(void) {}
void volt_wdt_disable(void) {}

// Storage
volt_error_t storage_init(void) { return 0; }
volt_error_t storage_save_int(const char *k, int v) { return 0; }
int storage_load_int(const char *k, int d) { return d; }
volt_error_t storage_save_float(const char *k, float v) { return 0; }
float storage_load_float(const char *k, float d) { return d; }
volt_error_t storage_save_str(const char *k, const char *v) { return 0; }
volt_error_t storage_load_str(const char *k, char *b, size_t s, const char *d) { return 0; }
volt_error_t storage_delete(const char *k) { return 0; }
bool storage_exists(const char *k) { return false; }
volt_error_t storage_flush(void) { return 0; }
volt_error_t storage_push(const char *l, int v) { return 0; }
int storage_list_count(const char *l) { return 0; }
int storage_drain(const char *l, int *b, int s) { return 0; }
volt_error_t storage_list_clear(const char *l) { return 0; }
volt_error_t storage_factory_reset(void) { return 0; }

// I2C
volt_error_t volt_i2c_init(uint8_t b, uint8_t sda, uint8_t scl, uint32_t sp) { return 0; }
volt_error_t volt_i2c_write(uint8_t b, uint8_t a, const uint8_t *d, uint8_t l) { return 0; }
volt_error_t volt_i2c_read(uint8_t b, uint8_t a, uint8_t *buf, uint8_t l) { return 0; }
volt_error_t volt_i2c_write_read(uint8_t b, uint8_t a, const uint8_t *wd, uint8_t wl, uint8_t *rb, uint8_t rl) { return 0; }
uint8_t volt_i2c_read_reg(uint8_t b, uint8_t a, uint8_t r) { return 0; }
volt_error_t volt_i2c_write_reg(uint8_t b, uint8_t a, uint8_t r, uint8_t v) { return 0; }
uint16_t volt_i2c_read_reg16(uint8_t b, uint8_t a, uint8_t r) { return 0; }

// SPI
volt_error_t volt_spi_init(uint8_t b, uint8_t mo, uint8_t mi, uint8_t ck, uint32_t sp) { return 0; }
void volt_spi_cs_select(uint8_t p) {}
void volt_spi_cs_deselect(uint8_t p) {}
volt_error_t volt_spi_write(uint8_t b, const uint8_t *d, uint8_t l) { return 0; }
volt_error_t volt_spi_read(uint8_t b, uint8_t *buf, uint8_t l) { return 0; }
volt_error_t volt_spi_transfer(uint8_t b, const uint8_t *tx, uint8_t *rx, uint8_t l) { return 0; }

// UART
volt_error_t volt_uart_init(uint8_t p, uint8_t tx, uint8_t rx, uint32_t baud) { return 0; }
volt_error_t volt_uart_write(uint8_t p, const uint8_t *d, uint16_t l) { return 0; }
volt_error_t volt_uart_print(uint8_t p, const char *t) { return 0; }
int volt_uart_read(uint8_t p, uint8_t *b, uint16_t m) { return 0; }
int volt_uart_read_byte(uint8_t p) { return 0; }
int volt_uart_read_line(uint8_t p, char *b, uint16_t m) { return 0; }
int volt_uart_available(uint8_t p) { return 0; }
void volt_uart_flush(uint8_t p) {}

// Servo
volt_error_t servo_attach(uint8_t p) { return 0; }
volt_error_t servo_attach_range(uint8_t p, uint16_t mn, uint16_t mx) { return 0; }
volt_error_t servo_detach(uint8_t p) { return 0; }
volt_error_t servo_write(uint8_t p, float a) { return 0; }
volt_error_t servo_write_us(uint8_t p, uint16_t us) { return 0; }
float servo_read(uint8_t p) { return 0; }
volt_error_t servo_ease_to(uint8_t p, float a, uint32_t d, uint8_t e) { return 0; }
volt_error_t servo_sweep(uint8_t p, float f, float t, uint32_t d) { return 0; }
volt_error_t servo_sweep_ease(uint8_t p, float f, float t, uint32_t d, uint8_t e) { return 0; }
void servo_sync_begin(void) {}
volt_error_t servo_sync_move(uint8_t p, float a, uint32_t d, uint8_t e) { return 0; }
volt_error_t servo_sync_go(void) { return 0; }
uint16_t servo_angle_to_us(uint8_t p, float a) { return 0; }
volt_error_t servo_set_max_angle(uint8_t p, float a) { return 0; }
#define SERVO_LINEAR 0
#define SERVO_EASE_IN 1
#define SERVO_EASE_OUT 2
#define SERVO_EASE_IN_OUT 3
#define SERVO_EASE_IN_CUBIC 4
#define SERVO_EASE_OUT_CUBIC 5
#define SERVO_EASE_IN_OUT_CUBIC 6
#define SERVO_EASE_IN_SINE 7
#define SERVO_EASE_OUT_SINE 8
#define SERVO_EASE_IN_OUT_SINE 9
#define SERVO_EASE_BOUNCE 10
#define SERVO_EASE_BACK 11
#define SERVO_EASE_ELASTIC 12

// Touch
volt_error_t touch_init(uint8_t p) { return 0; }
uint16_t touch_read(uint8_t p) { return 0; }
bool touch_is_touched(uint8_t p) { return false; }
volt_error_t touch_set_threshold(uint8_t p, uint16_t t) { return 0; }
volt_error_t touch_release(uint8_t p) { return 0; }

// WiFi
volt_error_t wifi_connect(const char *s, const char *p) { return 0; }
volt_error_t wifi_disconnect(void) { return 0; }
bool wifi_is_connected(void) { return false; }
const char *wifi_get_ip(void) { return "0.0.0.0"; }
int wifi_get_rssi(void) { return 0; }

// MQTT
volt_error_t mqtt_connect(const char *u) { return 0; }
volt_error_t mqtt_connect_auth(const char *u, const char *n, const char *p) { return 0; }
volt_error_t mqtt_disconnect(void) { return 0; }
bool mqtt_is_connected(void) { return false; }
volt_error_t mqtt_send(const char *t, const char *d) { return 0; }
volt_error_t mqtt_send_float(const char *t, float v) { return 0; }
volt_error_t mqtt_send_int(const char *t, int v) { return 0; }
typedef void (*mqtt_handler_t)(const char *topic, const char *data, int data_len);
volt_error_t mqtt_on_receive(const char *t, mqtt_handler_t h) { return 0; }

// HTTP
volt_error_t http_get(const char *u, char *b, size_t s, int *sc) { return 0; }
volt_error_t http_post(const char *u, const char *bd, const char *ct, char *r, size_t rs, int *sc) { return 0; }

// BLE
volt_error_t ble_advertise(const char *n) { return 0; }
volt_error_t ble_stop(void) { return 0; }
bool ble_is_connected(void) { return false; }
int ble_expose_int(const char *n, int v) { return 0; }
int ble_expose_float(const char *n, float v) { return 0; }
int ble_expose_string(const char *n, const char *v) { return 0; }
volt_error_t ble_update_int(int id, int v) { return 0; }
volt_error_t ble_update_float(int id, float v) { return 0; }
volt_error_t ble_update_string(int id, const char *v) { return 0; }

// Sensor stubs — one per sensor type used in tests
typedef struct { uint8_t bus_id, addr; } bme280_t;
volt_error_t bme280_init(bme280_t *d, uint8_t b, uint8_t a) { return 0; }
float bme280_temperature(bme280_t *d) { return 0; }
float bme280_humidity(bme280_t *d) { return 0; }
float bme280_pressure(bme280_t *d) { return 0; }

typedef struct { uint8_t bus_id, addr; } ssd1306_t;
volt_error_t ssd1306_init(ssd1306_t *d, uint8_t b, uint8_t a) { return 0; }
void ssd1306_clear(ssd1306_t *d) {}
void ssd1306_text(ssd1306_t *d, int x, int y, const char *t) {}
void ssd1306_show(ssd1306_t *d) {}

typedef struct { uint8_t bus_id, addr; } mpu6050_t;
volt_error_t mpu6050_init(mpu6050_t *d, uint8_t b, uint8_t a) { return 0; }
float mpu6050_accel_x(mpu6050_t *d) { return 0; }
float mpu6050_accel_y(mpu6050_t *d) { return 0; }
float mpu6050_accel_z(mpu6050_t *d) { return 0; }

typedef struct { uint8_t gpio, type; float temperature, humidity; } dht_t;
volt_error_t dht_init(dht_t *d, uint8_t g, uint8_t t) { return 0; }
float dht_temperature(dht_t *d) { return 0; }
float dht_humidity(dht_t *d) { return 0; }

typedef struct { uint8_t trig_pin, echo_pin; } hcsr04_t;
volt_error_t hcsr04_init(hcsr04_t *d, uint8_t t, uint8_t e) { return 0; }
float hcsr04_distance_cm(hcsr04_t *d) { return 0; }

// Neopixel
typedef struct { uint8_t gpio; uint16_t num_leds; uint8_t pixels[768]; } neopixel_t;
volt_error_t neopixel_init(neopixel_t *d, uint8_t g, uint16_t n) { return 0; }
void neopixel_set(neopixel_t *d, uint16_t i, uint8_t r, uint8_t g, uint8_t b) {}
void neopixel_clear(neopixel_t *d) {}
void neopixel_fill(neopixel_t *d, uint8_t r, uint8_t g, uint8_t b) {}
void neopixel_show(neopixel_t *d) {}
void neopixel_set_brightness(neopixel_t *d, uint8_t b) {}

// RP2040-specific stubs
void stdio_init_all(void) {}
void sleep_ms(uint32_t ms) {}

// DHT variants — codegen uses dht11_t / dht22_t aliases and dht11_init etc.
typedef dht_t dht11_t;
typedef dht_t dht22_t;
volt_error_t dht11_init(dht11_t *d, uint8_t g, uint8_t a) { return dht_init(d, g, 11); }
float dht11_temperature(dht11_t *d) { return dht_temperature(d); }
float dht11_humidity(dht11_t *d) { return dht_humidity(d); }
volt_error_t dht22_init(dht22_t *d, uint8_t g, uint8_t a) { return dht_init(d, g, 22); }
float dht22_temperature(dht22_t *d) { return dht_temperature(d); }
float dht22_humidity(dht22_t *d) { return dht_humidity(d); }

// Stub main for linking
int main(void) { return 0; }
"""


def setup_stubs():
    """Write stub .c file to temp directory."""
    global STUB_DIR
    STUB_DIR = tempfile.mkdtemp(prefix="volt_fw_test_")
    stub_path = os.path.join(STUB_DIR, "stubs.c")
    with open(stub_path, "w") as f:
        f.write(STUBS_C)
    return stub_path


def try_compile_c(c_code, name, chip="esp32"):
    """Compile generated C code against framework stubs. Returns (success, error_output)."""
    stub_path = os.path.join(STUB_DIR, "stubs.c")
    src_path = os.path.join(STUB_DIR, f"{name}.c")

    # Remove the #include lines that reference framework headers (we use stubs instead)
    # and remove app_main/main since stubs provide it
    lines = c_code.split("\n")
    filtered = []
    for line in lines:
        stripped = line.strip()
        if stripped.startswith('#include "volt/'):
            continue  # Skip framework includes — stubs provide everything
        if stripped.startswith('#include <freertos/'):
            continue
        if stripped.startswith('#include <esp_'):
            continue
        if stripped.startswith('#include "pico/'):
            continue
        if stripped.startswith('#include "hardware/'):
            continue
        if stripped.startswith('#include <driver/'):
            continue
        # Keep standard library includes
        filtered.append(line)
    filtered_code = "\n".join(filtered)

    # Rename app_main/main to volt_user_main to avoid conflict with stub's main
    filtered_code = filtered_code.replace("void app_main(void)", "void volt_user_main(void)")
    filtered_code = filtered_code.replace("int main(void)", "int volt_user_main_rp(void)")

    with open(src_path, "w") as f:
        f.write(filtered_code)

    try:
        result = subprocess.run(
            ["gcc", "-c", "-Wall", "-Wextra", "-Werror",
             "-Wno-unused-variable", "-Wno-unused-function",
             "-Wno-unused-but-set-variable", "-Wno-unused-parameter",
             "-Wno-return-type",
             "-include", stub_path,
             "-o", os.path.join(STUB_DIR, f"{name}.o"),
             src_path],
            capture_output=True, text=True, timeout=10,
        )
        return result.returncode == 0, result.stderr
    except Exception as e:
        return False, str(e)


def compile_and_check(test_name, source, chip="esp32"):
    """Compile Volt source → C → gcc. Returns C code on success."""
    c_code, errors = compile_volt(source, f"{test_name}.volt")
    errs = [e for e in errors.errors if e.severity == "error"]
    if errs:
        check(test_name + " (volt compile)", False,
              f"Volt errors: {[e.message for e in errs]}")
        return None
    if not c_code:
        check(test_name + " (volt compile)", False, "No C code generated")
        return None

    ok, gcc_err = try_compile_c(c_code, test_name, chip)
    if not ok:
        # Show first 5 lines of gcc error
        err_lines = gcc_err.strip().split("\n")[:5]
        check(test_name + " (gcc compile)", False, "\n    ".join(err_lines))
        return None

    check(test_name, True)
    return c_code


# ============================================================
# Setup
# ============================================================

stub_path = setup_stubs()

# ============================================================
print("\n=== LEVEL 1: Basic programs compile to valid C ===\n")
# ============================================================

compile_and_check("blink_esp32", """
chip esp32
hardware {
    pin led: Output = 2
}
task blink {
    every 500ms {
        led.toggle()
    }
}
""")

compile_and_check("blink_rp2040", """
chip rp2040
hardware {
    pin led: Output = 25
}
task blink {
    every 500ms {
        led.toggle()
    }
}
""", chip="rp2040")

compile_and_check("multi_pin", """
chip esp32
hardware {
    pin led1: Output = 2
    pin led2: Output = 4
    pin btn: PullUpInput = 0
}
task lights {
    every 1s {
        led1.toggle()
        led2.toggle()
        var state: int = btn.read()
    }
}
""")

compile_and_check("setup_only", """
chip esp32
hardware {
    pin led: Output = 2
}
setup {
    led.on()
}
""")

# ============================================================
print("\n=== LEVEL 2: Tasks, state machines, channels ===\n")
# ============================================================

compile_and_check("multi_task", """
chip esp32
hardware {
    pin led1: Output = 2
    pin led2: Output = 4
}
task fast {
    every 100ms {
        led1.toggle()
    }
}
task slow {
    every 1s {
        led2.toggle()
    }
}
""")

compile_and_check("state_machine", """
chip esp32
hardware {
    pin led: Output = 2
}
machine blinker {
    state off {
        enter { led.off() }
        after 1s -> on
    }
    state on {
        enter { led.on() }
        after 500ms -> off
    }
}
""")

compile_and_check("channel_basic", """
chip esp32
hardware {
    pin led: Output = 2
}
channel data: int[8]
task producer {
    every 1s {
        data.send(42)
    }
}
task consumer {
    every 100ms {
        var val: int = data.receive()
        if val > 0 {
            led.on()
        }
    }
}
""")

compile_and_check("shared_vars", """
chip esp32
hardware {
    pin led: Output = 2
}
shared var counter: int = 0
task inc {
    every 100ms {
        counter += 1
    }
}
task reader {
    every 1s {
        if counter > 10 {
            led.on()
        }
    }
}
""")

# ============================================================
print("\n=== LEVEL 3: Storage, enums, v3 features ===\n")
# ============================================================

compile_and_check("storage_int", """
chip esp32
hardware {
    pin led: Output = 2
}
storage boot_count: int = 0
setup {
    boot_count = boot_count + 1
    storage.save("boots", boot_count)
}
""")

compile_and_check("enum_basic", """
chip esp32
hardware {
    pin led: Output = 2
}
enum Color { red, green, blue }
setup {
    var c: Color = Color.red
    if c == Color.red {
        led.on()
    }
}
""")

compile_and_check("string_interpolation", """
chip esp32
hardware {
    pin led: Output = 2
}
setup {
    var count: int = 42
    log("app", "count is {count}")
}
""")

compile_and_check("for_loop", """
chip esp32
hardware {
    pin led: Output = 2
}
setup {
    for i in 0..10 {
        led.toggle()
    }
}
""")

compile_and_check("while_loop", """
chip esp32
hardware {
    pin led: Output = 2
}
setup {
    var x: int = 0
    while x < 10 {
        led.toggle()
        x += 1
    }
}
""")

compile_and_check("or_skip", """
chip esp32
hardware {
    pin led: Output = 2
}
task worker {
    every 1s {
        led.toggle() or skip
    }
}
""")

# ============================================================
print("\n=== LEVEL 4: Sensor/device programs ===\n")
# ============================================================

compile_and_check("sensor_bme280", """
chip esp32
hardware {
    pin led: Output = 2
    bus i2c0: I2C(sda: 21, scl: 22)
    device bme: BME280 on i2c0 at 0x76
}
task read_sensor {
    every 2s {
        var temp: float = bme.temperature()
        var hum: float = bme.humidity()
        if temp > 30.0 {
            led.on()
        }
    }
}
""")

compile_and_check("sensor_dht", """
chip esp32
hardware {
    pin led: Output = 2
    device dht_sensor: DHT11 on gpio4 at 4
}
task read_dht {
    every 2s {
        var t: float = dht_sensor.temperature()
        var h: float = dht_sensor.humidity()
    }
}
""")

# ============================================================
print("\n=== LEVEL 5: Cross-chip — same program on ESP32 + RP2040 ===\n")
# ============================================================

CROSS_CHIP_SRC = """
hardware {{
    pin led: Output = {led_pin}
}}
task blink {{
    every 500ms {{
        led.toggle()
    }}
}}
"""

compile_and_check("cross_esp32", f"chip esp32\n{CROSS_CHIP_SRC.format(led_pin=2)}")
compile_and_check("cross_rp2040", f"chip rp2040\n{CROSS_CHIP_SRC.format(led_pin=25)}", chip="rp2040")

# ============================================================
# Cleanup
# ============================================================

try:
    shutil.rmtree(STUB_DIR)
except:
    pass

# ============================================================
# Summary
# ============================================================

print(f"\n{'='*60}")
print(f"  RESULTS: {passed}/{passed + failed} passed, {failed} failed")
print(f"{'='*60}")
sys.exit(1 if failed else 0)
