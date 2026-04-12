chip esp32

hardware {
    pin red: Output = 23
    pin green: Output = 22
    pin yellow: Output = 21
    pin button: Input.PullUp = 4
    pin sensor: Analog = 36
}

var red_count: int = 0
var green_count: int = 0
var button_presses: int = 0
var last_button: int = 1

task blink_red {
    every 100ms {
        red.toggle()
        red_count = red_count + 1
        if red_count % 10 == 0 {
            log("red", "toggles=" + red_count)
        }
    }
}

task blink_green {
    every 400ms {
        green.toggle()
        green_count = green_count + 1
        log("green", "toggle #" + green_count)
    }
}

task read_button {
    every 50ms {
        let state = button.read()
        if state == 0 {
            if last_button == 1 {
                button_presses = button_presses + 1
                log("button", "PRESSED #" + button_presses)
            }
            yellow.on()
        } else {
            yellow.off()
        }
        last_button = state
    }
}

task adc_monitor {
    every 2seconds {
        let val = sensor.read()
        log("adc", "GPIO36 ADC1_CH0 raw=" + val)
    }
}

setup {
    log("system", "=== ESP32 Multi-Pin Test ===")
    log("system", "pins: red=23, green=22, yellow=21, button=4(pullup), adc=36")
    log("system", "expected: red@100ms, green@400ms, button@50ms poll, adc@2s")
    run(blink_red, blink_green, read_button, adc_monitor)
}
