chip esp32

hardware {
    pin led_r: Output = 23
    pin led_g: Output = 22
    pin led_b: Output = 21
    pin motor: PWM = 4
    pin fan: Output = 5
    pin button: Input.PullUp = 15
    pin soil: Analog = 32
    pin temp: Analog = 33
    pin light: Analog = 34
}

var setpoint: int = 500
var fan_on: int = 0
var total_sensor_reads: int = 0
var total_pushes: int = 0
var total_syncs: int = 0
var motor_isr_count: int = 0
var button_presses: int = 0
var last_button: int = 1

func check_threshold(value: int, limit: int) -> bool {
    return value > limit
}

task sensor_poll() {
    every 2seconds {
        let s = soil.read()
        let t = temp.read()
        let l = light.read()
        total_sensor_reads = total_sensor_reads + 1

        log("sensor", "#" + total_sensor_reads + " soil=" + s + " temp=" + t + " light=" + l + " setpoint=" + setpoint)

        if check_threshold(t, 800) {
            fan.on()
            fan_on = 1
            log("sensor", "TEMP HIGH -> fan ON")
        } else {
            fan.off()
            fan_on = 0
        }

        if s < setpoint {
            motor.set_pwm(200)
            log("sensor", "SOIL DRY -> pump ON (pwm=200)")
        } else {
            motor.set_pwm(0)
            log("sensor", "SOIL OK -> pump OFF")
        }
    }
}

task pid_control() {
    every 1ms strict {
        motor.set_pwm(0)
        motor_isr_count = motor_isr_count + 1
    }
}

task button_monitor() {
    every 50ms {
        let state = button.read()
        if state == 0 {
            if last_button == 1 {
                button_presses = button_presses + 1
                log("button", "PRESS #" + button_presses + " on GPIO 15")
            }
        }
        last_button = state
    }
}

task data_logger() {
    every 30seconds {
        storage.push("soil", soil.read())
        storage.push("temp", temp.read())
        storage.push("light", light.read())
        total_pushes = total_pushes + 3
        log("storage", "pushed 3 readings | total_pushes=" + total_pushes + " list_count=" + storage.list_count("soil"))
    }
}

task cloud_sync() {
    every 60seconds {
        if wifi.is_connected() {
            total_syncs = total_syncs + 1
            log("sync", "#" + total_syncs + " draining + sending")
            mqtt.send_int("farm/soil", soil.read())
            mqtt.send_int("farm/temp", temp.read())
            mqtt.send_int("farm/light", light.read())
            mqtt.send_int("farm/fan", fan_on)
            log("sync", "mqtt send complete")
        } else {
            log("sync", "SKIP — wifi not connected, data buffered in storage")
        }
    }
}

task health_report() {
    every 10seconds {
        log("health", "=== HEALTH REPORT ===")
        log("health", "  sensor_reads=" + total_sensor_reads)
        log("health", "  motor_isr=" + motor_isr_count)
        log("health", "  button_presses=" + button_presses)
        log("health", "  storage_pushes=" + total_pushes)
        log("health", "  cloud_syncs=" + total_syncs)
        log("health", "  wifi=" + wifi.is_connected())
        log("health", "  heap=" + system.free_heap())
        log("health", "  fan=" + fan_on + " setpoint=" + setpoint)
        log("health", "====================")
    }
}

machine StatusLED {
    initial state off {
        enter {
            led_r.off()
            led_g.off()
            led_b.off()
            log("led_fsm", "STATE -> off | all LEDs off")
        }
        on wifi_connected -> connected
    }

    state connected {
        enter {
            led_g.on()
            log("led_fsm", "STATE -> connected | green ON")
        }
        exit {
            led_g.off()
        }
        on wifi_lost -> disconnected
        on error_event -> error
    }

    state disconnected {
        enter {
            led_r.on()
            log("led_fsm", "STATE -> disconnected | red ON")
        }
        exit {
            led_r.off()
        }
        after 5seconds -> off
        on wifi_connected -> connected
    }

    state error {
        enter {
            led_r.on()
            led_b.on()
            log("led_fsm", "STATE -> error | red+blue ON")
        }
        exit {
            led_r.off()
            led_b.off()
        }
        after 10seconds -> off
    }
}

main {
    log("system", "=== ESP32 Complex All-Features Test ===")
    log("system", "pins: led_r=23, led_g=22, led_b=21, motor=4(PWM), fan=5, button=15, soil=32, temp=33, light=34")
    log("system", "tasks: sensor@2s, pid@1ms(strict), button@50ms, logger@30s, sync@60s, health@10s")
    log("system", "state machine: StatusLED (off->connected->disconnected->error)")
    log("system", "connecting wifi...")
    wifi.connect("FarmNet", "password")
    log("system", "connecting mqtt...")
    mqtt.connect("mqtt://broker.local")
    log("system", "starting all tasks")
    run(sensor_poll, pid_control, button_monitor, data_logger, cloud_sync, health_report)
}
