chip rp2040

hardware {
    pin led: Output = GP25
}

task blink {
    var count: int = 0
    every 500ms {
        led.toggle()
        count += 1
    }
}
