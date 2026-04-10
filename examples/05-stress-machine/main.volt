chip esp32

hardware {
    pin led: Output = 2
    pin motor: PWM = 4
}

machine Sequencer {
    var step = 0
    var total_cycles = 0

    initial state phase_a {
        enter {
            step = 0
            led.on()
            log("phase A start")
        }
        exit {
            led.off()
        }
        after 1seconds -> phase_b {
            step = step + 1
        }
    }

    state phase_b {
        enter {
            log("phase B start")
        }
        after 800ms -> phase_c {
            step = step + 1
        }
    }

    state phase_c {
        enter {
            log("phase C start")
        }
        after 600ms -> phase_d {
            step = step + 1
        }
    }

    state phase_d {
        enter {
            log("phase D start")
        }
        after 400ms -> phase_e {
            step = step + 1
        }
    }

    state phase_e {
        enter {
            log("phase E — cycle complete")
            total_cycles = total_cycles + 1
        }
        after 200ms -> phase_a
    }
}

machine Watchdog {
    var checks = 0

    initial state monitoring {
        after 2seconds -> checking
    }

    state checking {
        enter {
            checks = checks + 1
            log("watchdog check")
        }
        after 100ms -> monitoring
    }
}

task motor_pid() {
    every 1ms strict {
        motor.set_pwm(0)
    }
}

task heartbeat() {
    var beat = 0
    every 500ms {
        beat = beat + 1
        led.toggle()
    }
}

task counter() {
    var c = 0
    every 100ms {
        c = c + 1
    }
}

main {
    run(heartbeat, counter)
}
