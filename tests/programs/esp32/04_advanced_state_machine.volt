chip esp32

hardware {
    pin led: Output = 2
    pin buzzer: PWM = 18
    pin button: Input.PullUp = 4
}

machine Alarm {
    let attempts: int = 0

    initial state idle {
        enter {
            led.off()
            buzzer.set_pwm(0)
            log("alarm", "STATE -> idle | led=off buzzer=off")
        }
        on arm_cmd -> armed
    }

    state armed {
        enter {
            led.on()
            log("alarm", "STATE -> armed | led=on, waiting for motion")
        }
        on motion -> triggered
        on disarm_cmd -> idle
    }

    state triggered {
        enter {
            buzzer.set_pwm(200)
            log("alarm", "STATE -> triggered | buzzer=200, attempts=" + attempts)
        }
        exit {
            buzzer.set_pwm(0)
            log("alarm", "exiting triggered | buzzer=off")
        }
        on correct_code -> idle
        on wrong_code -> triggered
        after 60seconds -> siren
    }

    state siren {
        enter {
            buzzer.set_pwm(255)
            log("alarm", "STATE -> siren | buzzer=MAX, full alarm")
        }
        exit {
            buzzer.set_pwm(0)
            log("alarm", "exiting siren | buzzer=off")
        }
        after 300seconds -> idle
        on master_code -> idle
    }
}

main {
    log("system", "=== ESP32 State Machine Test ===")
    log("system", "states: idle -> armed -> triggered -> siren -> idle")
    log("system", "verify: enter/exit actions logged at each transition")
}
