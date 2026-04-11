chip rp2040

hardware {
    pin led: Output = GP25
}

var count: int = 0

task blink() {
    every 500ms {
        led.toggle()
        count = count + 1
    }
}

main {
    run(blink)
}
