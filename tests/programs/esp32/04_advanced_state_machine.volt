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
        }
        on arm_cmd -> armed
    }

    state armed {
        enter {
            led.on()
        }
        on motion -> triggered
        on disarm_cmd -> idle
    }

    state triggered {
        enter {
            buzzer.set_pwm(200)
        }
        exit {
            buzzer.set_pwm(0)
        }
        on correct_code -> idle
        on wrong_code -> triggered
        after 60seconds -> siren
    }

    state siren {
        enter {
            buzzer.set_pwm(255)
        }
        exit {
            buzzer.set_pwm(0)
        }
        after 300seconds -> idle
        on master_code -> idle
    }
}
