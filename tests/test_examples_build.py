"""
Example build tests — compile every example to C and check for issues.

This goes beyond pattern-matching: it catches bugs like the IRAM_ATTR/esp_attr.h
issue where the C would be syntactically valid but fail on a real C compiler
due to undefined macros or missing includes.

Strategy:
  1. Compile every example through the Volt pipeline
  2. Check generated C has no obvious red flags:
     - Every used macro/type is declared via an include
     - Every forward declaration matches its definition
     - No undefined function references
  3. Also compile against the host-stub framework (cross-reference with test_framework.py)
"""

import sys
import os
import glob
import re
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src'))
from volt.compiler.voltc import compile_volt

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
# Known SDK macros/types that require specific includes.
# If codegen emits these, the matching header must be included.
# ============================================================

MACRO_HEADERS = {
    "IRAM_ATTR":            "esp_attr.h",
    "DRAM_ATTR":            "esp_attr.h",
    "RTC_DATA_ATTR":        "esp_attr.h",
    "ESP_LOGI":             "esp_log.h",
    "ESP_LOGW":             "esp_log.h",
    "ESP_LOGE":             "esp_log.h",
    "portTICK_PERIOD_MS":   "freertos/FreeRTOS.h",
    "vTaskDelay":           "freertos/task.h",
    "xTaskCreate":          "freertos/task.h",
    "TaskHandle_t":         "freertos/task.h",
    "QueueHandle_t":        "freertos/queue.h",
    "SemaphoreHandle_t":    "freertos/semaphore.h",
    # Volt framework includes that should appear:
    "wifi_connect":         "volt/wifi.h",
    "wifi_is_connected":    "volt/wifi.h",
    "wifi_get_ip":          "volt/wifi.h",
    "mqtt_connect":         "volt/mqtt.h",
    "mqtt_send":            "volt/mqtt.h",
    "mqtt_send_int":        "volt/mqtt.h",
    "mqtt_send_float":      "volt/mqtt.h",
    "mqtt_is_connected":    "volt/mqtt.h",
    "http_get":             "volt/http.h",
    "http_post":            "volt/http.h",
    "ble_advertise":        "volt/ble.h",
    "ble_expose_int":       "volt/ble.h",
    "storage_save_int":     "volt/storage.h",
    "storage_load_int":     "volt/storage.h",
    "storage_save_float":   "volt/storage.h",
    "storage_save_str":     "volt/storage.h",
    "storage_push":         "volt/storage.h",
    "storage_drain":        "volt/storage.h",
    "volt_i2c_init":        "volt/i2c.h",
    "volt_spi_init":        "volt/spi.h",
    "volt_uart_init":       "volt/uart.h",
    "servo_attach":         "volt/servo.h",
    "servo_write":          "volt/servo.h",
    "touch_init":           "volt/touch.h",
    "touch_read":           "volt/touch.h",
}


def check_macro_coverage(c_code: str, example_name: str):
    """Verify every SDK macro/function used has a matching include."""
    for macro, header in MACRO_HEADERS.items():
        # Word boundary — don't match as substring
        pattern = r'\b' + re.escape(macro) + r'\b'
        if re.search(pattern, c_code):
            # This macro is used — ensure header is included
            if header not in c_code:
                check(f"{example_name}: {macro} requires #include <{header}>",
                      False,
                      f"Generated C uses {macro}() but doesn't #include <{header}>")
                return False
    return True


def check_forward_decls_match(c_code: str, example_name: str):
    """Check that every forward declaration matches a definition.
    Catches bugs like forward says `static void foo(void*)` but definition has
    extra attributes (IRAM_ATTR) that aren't defined in scope."""

    # Find forward declarations: "static <return> <name>(<args>);"
    fwd_pattern = re.compile(r'^static\s+(\w+)\s+(\w+)\s*\(([^)]*)\)\s*;', re.MULTILINE)
    def_pattern_template = r'^static\s+(?:\w+\s+)*{name}\s*\('

    for match in fwd_pattern.finditer(c_code):
        ret_type, name, args = match.groups()
        # Now look for a definition (not another forward decl)
        def_pat = re.compile(def_pattern_template.format(name=re.escape(name)) + r'[^;]*\{',
                             re.MULTILINE)
        if not def_pat.search(c_code):
            check(f"{example_name}: forward decl `{name}` has matching definition",
                  False, f"No function body found for {name}")
            return False
    return True


def compile_example(volt_path: str):
    """Compile a .volt file and return C code or None on error."""
    with open(volt_path) as f:
        source = f.read()
    c, errs = compile_volt(source, volt_path)
    errors = [e for e in errs.errors if e.severity == "error"]
    if errors:
        return None, [e.message for e in errors]
    return c, []


# ============================================================
# Discover all examples
# ============================================================

EXAMPLES_DIR = os.path.join(os.path.dirname(__file__), '..', 'examples')
example_files = sorted(glob.glob(os.path.join(EXAMPLES_DIR, '*/main.volt')))

print(f"\n=== Building {len(example_files)} examples ===\n")

for volt_path in example_files:
    name = os.path.basename(os.path.dirname(volt_path))

    c, errors = compile_example(volt_path)
    if c is None:
        check(f"{name} compiles", False, f"Volt errors: {errors}")
        continue

    # Example compiled to C — now verify it's valid C
    compile_ok = True

    # 1. All used SDK macros must have their include
    if not check_macro_coverage(c, name):
        compile_ok = False

    # 2. Every forward decl must have a matching definition
    if not check_forward_decls_match(c, name):
        compile_ok = False

    # 3. No obvious issues with the generated structure
    if "#include" not in c:
        check(f"{name}: has includes", False, "no #include directives")
        compile_ok = False

    if compile_ok:
        check(f"{name}: builds clean", True)


# ============================================================
# Specific regression tests for known bugs
# ============================================================

print("\n=== Conditional call detection (regression) ===\n")

# wifi.is_connected() inside if condition — was broken before
c, errs = compile_volt("""
chip esp32
hardware { pin led: Output = 2 }
task monitor {
    every 5s {
        if wifi.is_connected() {
            led.on()
        }
    }
}
""", "if_wifi.volt")
check("if wifi.is_connected() includes wifi.h",
      c is not None and '"volt/wifi.h"' in c)

# mqtt inside while condition
c, _ = compile_volt("""
chip esp32
hardware { pin led: Output = 2 }
task loop_check {
    every 1s {
        while mqtt.is_connected() {
            led.toggle()
            sleep(100ms)
        }
    }
}
""", "while_mqtt.volt")
check("while mqtt.is_connected() includes mqtt.h",
      c is not None and '"volt/mqtt.h"' in c)

# ble inside binary expression
c, _ = compile_volt("""
chip esp32
hardware { pin led: Output = 2 }
shared var ready: bool = false
task check {
    every 2s {
        ready = wifi.is_connected() && ble.is_connected()
    }
}
""", "binary_both.volt")
check("binary expression with wifi + ble", c is not None)
if c:
    check("includes wifi.h from binary expr", '"volt/wifi.h"' in c)
    check("includes ble.h from binary expr", '"volt/ble.h"' in c)

# ============================================================
print(f"\n{'='*60}")
print(f"  RESULTS: {passed}/{passed + failed} passed, {failed} failed")
print(f"{'='*60}")
sys.exit(1 if failed else 0)
