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
var fan_on: bool = false

struct SensorData {
    soil: int
    temp: int
    light: int
}

func check_threshold(value: int, limit: int) -> bool {
    return value > limit
}

task sensor_poll() {
    every 2seconds {
        let s = soil.read()
        let t = temp.read()
        let l = light.read()

        if check_threshold(t, 800) {
            fan.on()
            fan_on = true
        } else {
            fan.off()
            fan_on = false
        }

        if s < setpoint {
            motor.set_pwm(200)
        } else {
            motor.set_pwm(0)
        }
    }
}

task pid_control() {
    every 1ms strict {
        motor.set_pwm(0)
    }
}

task data_logger() {
    every 30seconds {
        storage.push("soil", soil.read())
        storage.push("temp", temp.read())
        storage.push("light", light.read())
    }
}

task cloud_sync() {
    every 60seconds {
        if wifi.is_connected() {
            mqtt.send_int("farm/soil", soil.read())
            mqtt.send_int("farm/temp", temp.read())
            mqtt.send_int("farm/light", light.read())
            mqtt.send_int("farm/fan", 1)
        }
    }
}

machine StatusLED {
    initial state off {
        enter {
            led_r.off()
            led_g.off()
            led_b.off()
        }
        on wifi_connected -> connected
    }

    state connected {
        enter {
            led_g.on()
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
        }
        exit {
            led_r.off()
            led_b.off()
        }
        after 10seconds -> off
    }
}

main {
    wifi.connect("FarmNet", "password")
    mqtt.connect("mqtt://broker.local")
    run(sensor_poll, pid_control, data_logger, cloud_sync)
}
