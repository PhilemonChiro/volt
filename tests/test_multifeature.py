"""
Multi-feature integration tests — complex programs combining many features.

These test real-world patterns: state machines + sensors + storage,
channels + shared vars + multiple tasks, enums + match + functions.
"""

import sys
import os
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

def c_has(c, text, name):
    check(name, c is not None and text in c, f"'{text}' not found")

def compile_ok(name, source):
    c, errs = compile_volt(source, f"{name}.volt")
    errors = [e for e in errs.errors if e.severity == "error"]
    if errors:
        check(name, False, f"Errors: {[e.message for e in errors]}")
        return None
    check(name, c is not None)
    return c


# ============================================================
print("\n=== State machine + sensor + storage ===\n")
# ============================================================

c = compile_ok("thermostat", """
chip esp32
hardware {
    pin heater: Output = 2
    pin fan: Output = 4
    bus i2c0: I2C(sda: 21, scl: 22)
    device bme: BME280 on i2c0 at 0x76
}

storage target_temp: int = 22

machine thermostat {
    state idle {
        enter {
            heater.off()
            fan.off()
        }
        after 5s -> heating
    }
    state heating {
        enter { heater.on() }
        exit { heater.off() }
        after 30s -> cooling
    }
    state cooling {
        enter { fan.on() }
        exit { fan.off() }
        after 30s -> idle
    }
}

task sensor_reader {
    every 2s {
        var temp: float = bme.temperature()
    }
}
""")
if c:
    c_has(c, "THERMOSTAT_IDLE", "state enum idle")
    c_has(c, "THERMOSTAT_HEATING", "state enum heating")
    c_has(c, "THERMOSTAT_COOLING", "state enum cooling")
    c_has(c, "bme280_temperature", "sensor read in state")
    c_has(c, "storage_init", "storage initialized")
    c_has(c, "storage_load_int", "storage loaded")


# ============================================================
print("\n=== Channel + shared var + multi-task ===\n")
# ============================================================

c = compile_ok("sensor_pipeline", """
chip esp32
hardware {
    pin led: Output = 2
}

shared var sample_count: int = 0
channel readings: int[16]

task sampler {
    every 100ms {
        readings.send(42)
        sample_count += 1
    }
}

task processor {
    every 50ms {
        if readings.has_data() {
            var val: int = readings.receive()
            if val > 40 {
                led.on()
            }
        }
    }
}

task monitor {
    every 5s {
        log("stats", "samples={sample_count}")
    }
}
""")
if c:
    c_has(c, "readings_send(42)", "channel send")
    c_has(c, "readings_receive()", "channel receive")
    c_has(c, "readings_has_data()", "channel has_data")
    c_has(c, "atomic_fetch_add", "shared var atomic increment")
    c_has(c, "sampler_run", "sampler task")
    c_has(c, "processor_run", "processor task")
    c_has(c, "monitor_run", "monitor task")
    c_has(c, "volt_run(_tasks, 3)", "3 tasks in table")


# ============================================================
print("\n=== Enum + match + function ===\n")
# ============================================================

c = compile_ok("traffic_light", """
chip esp32
hardware {
    pin red: Output = 2
    pin yellow: Output = 4
    pin green: Output = 5
}

enum Light { off, red, yellow, green }

func all_off() {
    red.off()
    yellow.off()
    green.off()
}

setup {
    var current: Light = Light.red
    all_off()
    match(current) {
        .red -> red.on()
        .yellow -> yellow.on()
        .green -> green.on()
        _ -> all_off()
    }
}
""")
if c:
    c_has(c, "LIGHT_OFF", "enum variant OFF")
    c_has(c, "LIGHT_RED", "enum variant RED")
    c_has(c, "LIGHT_YELLOW", "enum variant YELLOW")
    c_has(c, "LIGHT_GREEN", "enum variant GREEN")
    c_has(c, "all_off()", "function call")
    c_has(c, "== LIGHT_RED", "match arm comparison")


# ============================================================
print("\n=== or-skip + or-retry + shared vars ===\n")
# ============================================================

c = compile_ok("resilient", """
chip esp32
hardware {
    pin led: Output = 2
    pin buzzer: PWM = 5
}

task heartbeat {
    every 1s {
        led.toggle() or skip
    }
}

task alert {
    every 5s {
        buzzer.set_pwm(128) or retry(3)
        sleep(200ms)
        buzzer.set_pwm(0) or skip
    }
}
""")
if c:
    c_has(c, "continue;", "or skip generates continue")
    c_has(c, "_retry", "or retry generates retry loop")
    c_has(c, "VOLT_OK", "checks error code")


# ============================================================
print("\n=== Storage + string interpolation + for loop ===\n")
# ============================================================

c = compile_ok("data_logger", """
chip esp32
hardware {
    pin led: Output = 2
}

storage log_count: int = 0

setup {
    log_count = log_count + 1
    storage.save("runs", log_count)

    for i in 0..5 {
        log("init", "step {i}")
    }

    var msg: string = "Boot #{log_count}"
    log("boot", msg)
}
""")
if c:
    c_has(c, "storage_save_int", "save int")
    c_has(c, "snprintf(", "string interpolation")
    c_has(c, "for (int32_t", "for loop")
    c_has(c, 'log_info("boot", "%s",', "safe log format")


# ============================================================
print("\n=== Multi-every + crossing vars + when guard ===\n")
# ============================================================

c = compile_ok("guarded", """
chip esp32
hardware {
    pin led1: Output = 2
    pin led2: Output = 4
}

task worker {
    var count: int = 0
    every 500ms when count < 100 {
        led1.toggle()
        count = count + 1
    }
}

task slow {
    every 2s {
        led2.toggle()
    }
}
""")
if c:
    c_has(c, "worker_ctx_t", "context struct for crossing var")
    c_has(c, "ctx->count", "crossing var accessed via context")


# ============================================================
print("\n=== Servo + state machine ===\n")
# ============================================================

c = compile_ok("servo_machine", """
chip esp32
hardware {
    pin servo_pin: PWM = 13
}

machine arm {
    state home {
        enter {
            servo_pin.set_pwm(0)
        }
        after 3s -> sweep_right
    }
    state sweep_right {
        enter {
            servo_pin.set_pwm(255)
        }
        after 2s -> sweep_left
    }
    state sweep_left {
        enter {
            servo_pin.set_pwm(0)
        }
        after 2s -> home
    }
}
""")
if c:
    c_has(c, "ARM_HOME", "state enum")
    c_has(c, "ARM_SWEEP_RIGHT", "state enum")
    c_has(c, "ARM_SWEEP_LEFT", "state enum")


# ============================================================
print("\n=== Full IoT device (sensor + WiFi + MQTT + storage) ===\n")
# ============================================================

c = compile_ok("iot_device", """
chip esp32
hardware {
    pin led: Output = 2
    bus i2c0: I2C(sda: 21, scl: 22)
    device bme: BME280 on i2c0 at 0x76
}

storage readings_count: int = 0

setup {
    wifi.connect("MySSID", "MyPass")
    mqtt.connect("mqtt://broker.local")
}

task telemetry {
    every 30s {
        var temp: float = bme.temperature()
        var hum: float = bme.humidity()
        mqtt.send("home/temp", "temp={temp}")
        mqtt.send("home/hum", "hum={hum}")
        readings_count = readings_count + 1
        storage.save("count", readings_count)
        led.toggle()
    }
}
""")
if c:
    c_has(c, "wifi_connect", "WiFi connect")
    c_has(c, "mqtt_connect", "MQTT connect")
    c_has(c, "mqtt_send", "MQTT publish")
    c_has(c, "bme280_temperature", "sensor read")
    c_has(c, "storage_save_int", "storage save")
    c_has(c, "snprintf(", "string interpolation in mqtt")


# ============================================================
print(f"\n{'='*60}")
print(f"  RESULTS: {passed}/{passed + failed} passed, {failed} failed")
print(f"{'='*60}")
sys.exit(1 if failed else 0)
