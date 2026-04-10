chip esp32

hardware {
    pin led: Output = 2
}

var count: int = 0

task blink() {
    every 500ms {
        led.toggle()
        count = count + 1
        log("blink", "toggle #" + count + " | pin=2")
    }
}

main {
    log("system", "=== ESP32 Simple Blink Test ===")
    log("system", "expected: toggle every 500ms on GPIO 2")
    run(blink)
}
