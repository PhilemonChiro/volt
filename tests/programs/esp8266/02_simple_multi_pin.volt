chip esp8266

hardware {
    pin led: Output = 2
    pin relay: Output = 4
    pin button: Input.PullUp = 5
    pin status: Output = 12
    pin buzzer: Output = 14
}

var blink_count: int = 0
var button_presses: int = 0
var last_button: int = 1

task blink() {
    every 500ms {
        led.toggle()
        blink_count = blink_count + 1
        if blink_count % 10 == 0 {
            log("blink", "count=" + blink_count)
        }
    }
}

task read_button() {
    every 50ms {
        let pressed = button.read()
        if pressed == 0 {
            if last_button == 1 {
                button_presses = button_presses + 1
                log("button", "PRESSED #" + button_presses + " | relay=ON status=ON")
            }
            relay.on()
            status.on()
        } else {
            relay.off()
            status.off()
        }
        last_button = pressed
    }
}

task health() {
    every 5seconds {
        log("health", "blinks=" + blink_count + " presses=" + button_presses + " heap=" + system.free_heap())
    }
}

main {
    log("system", "=== ESP8266 Multi-Pin Test ===")
    log("system", "pins: led=2, relay=4, button=5(pullup), status=12, buzzer=14")
    log("system", "expected: blink@500ms, button@50ms poll")
    run(blink, read_button, health)
}
