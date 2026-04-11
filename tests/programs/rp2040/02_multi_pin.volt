chip rp2040

hardware {
    pin led: Output = GP25
    pin relay: Output = GP15
    pin button: Input.PullUp = GP14
    pin buzzer: Output = GP13
    pin sensor: Analog = GP26
}

var blink_count: int = 0
var button_presses: int = 0
var last_button: int = 1

task blink() {
    every 500ms {
        led.toggle()
        blink_count = blink_count + 1
    }
}

task read_button() {
    every 50ms {
        let pressed = button.read()
        if pressed == 0 {
            if last_button == 1 {
                button_presses = button_presses + 1
            }
            relay.on()
        } else {
            relay.off()
        }
        last_button = pressed
    }
}

task adc_read() {
    every 2seconds {
        let val = sensor.read()
    }
}

main {
    run(blink, read_button, adc_read)
}
