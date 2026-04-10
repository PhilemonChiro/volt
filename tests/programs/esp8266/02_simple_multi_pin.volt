chip esp8266

hardware {
    pin led: Output = 2
    pin relay: Output = 4
    pin button: Input.PullUp = 5
    pin status: Output = 12
    pin buzzer: Output = 14
}

task blink() {
    every 500ms {
        led.toggle()
    }
}

task read_button() {
    every 50ms {
        let pressed = button.read()
        if pressed == 0 {
            relay.on()
            status.on()
        } else {
            relay.off()
            status.off()
        }
    }
}

main {
    run(blink, read_button)
}
