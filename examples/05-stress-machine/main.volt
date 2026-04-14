chip esp32

hardware {
    pin led: Output = 2
    pin motor: PWM = 4
}

machine sequencer {
    var step: int = 0
    var total_cycles: int = 0

    initial state phase_a {
        enter {
            step = 0
            led.on()
            log("seq", "phase A start")
        }
        exit {
            led.off()
        }
        after 1s -> phase_b
    }

    state phase_b {
        enter {
            log("seq", "phase B start")
            step = step + 1
        }
        after 800ms -> phase_c
    }

    state phase_c {
        enter {
            log("seq", "phase C start")
            step = step + 1
        }
        after 600ms -> phase_d
    }

    state phase_d {
        enter {
            log("seq", "phase D start")
            step = step + 1
        }
        after 400ms -> phase_e
    }

    state phase_e {
        enter {
            log("seq", "phase E — cycle complete")
            total_cycles = total_cycles + 1
        }
        after 200ms -> phase_a
    }
}

machine watchdog_machine {
    var checks: int = 0

    initial state monitoring {
        after 2s -> checking
    }

    state checking {
        enter {
            checks = checks + 1
            log("wdt", "check")
        }
        after 100ms -> monitoring
    }
}

task motor_pid {
    every 1ms strict {
        motor.set_pwm(0)
    }
}

task heartbeat {
    var beat: int = 0
    every 500ms {
        beat = beat + 1
        led.toggle()
    }
}

task counter {
    var c: int = 0
    every 100ms {
        c = c + 1
    }
}
