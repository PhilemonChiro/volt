chip esp32

hardware {
    pin red: Output = 23
    pin green: Output = 22
    pin yellow: Output = 21
    pin button: Input.PullUp = 4
    pin sensor: Analog = 36
}

task blink_red() {
    every 100ms {
        red.toggle()
    }
}

task blink_green() {
    every 400ms {
        green.toggle()
    }
}

task read_button() {
    every 50ms {
        let state = button.read()
        if state == 0 {
            yellow.on()
        } else {
            yellow.off()
        }
    }
}

main {
    run(blink_red, blink_green, read_button)
}
