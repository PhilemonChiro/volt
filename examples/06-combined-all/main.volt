chip esp32

hardware {
    pin led: Output = 2
    pin motor: PWM = 5
    pin battery: Analog = 36
}

func clamp(val: int, lo: int, hi: int) -> int {
    if val < lo {
        return lo
    }
    if val > hi {
        return hi
    }
    return val
}

func scale(raw: int) -> int {
    return clamp(raw * 100 / 4095, 0, 100)
}

machine PowerManager {
    var battery_pct = 100
    var low_count = 0

    initial state normal {
        enter {
            log("power: normal")
            led.on()
        }
        exit {
            led.off()
        }
        after 10seconds -> check_battery
    }

    state check_battery {
        enter {
            battery_pct = scale(battery.read())
            log("battery check")
        }
        after 100ms [battery_pct < 20] -> low_power {
            low_count = low_count + 1
        }
        after 100ms -> normal
    }

    state low_power {
        enter {
            log("power: LOW")
        }
        after 30seconds -> check_battery
    }
}

machine LedController {
    var pattern = 0

    initial state solid {
        enter {
            led.on()
        }
        after 5seconds -> blink_fast {
            pattern = 1
        }
    }

    state blink_fast {
        enter {
            log("led: fast blink")
        }
        after 3seconds -> blink_slow {
            pattern = 2
        }
    }

    state blink_slow {
        enter {
            log("led: slow blink")
        }
        after 4seconds -> solid {
            pattern = 0
        }
    }
}

task blink() {
    every 100ms {
        led.toggle()
    }
}

task motor_pid() {
    every 1ms strict {
        motor.set_pwm(0)
    }
}

task slow_counter() {
    var n = 0
    every 2seconds {
        n = n + 1
        let bat = battery.read()
        let pct = scale(bat)
        log("status tick")
    }
}

task fast_counter() {
    var x = 0
    every 50ms {
        x = x + 1
    }
}

task medium_counter() {
    var y = 0
    every 333ms {
        y = y + 1
    }
}


main {
    run(blink, slow_counter, fast_counter, medium_counter)
}
