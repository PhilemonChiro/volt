chip esp8266

hardware {
    pin led: Output = 2
}

var count: int = 0

task blink() {
    every 500ms {
        led.toggle()
        count = count + 1
        log("blink", "toggle #" + count + " | pin=2 (onboard LED, active LOW)")
    }
}

main {
    log("system", "=== ESP8266 Simple Blink Test ===")
    log("system", "GPIO 2 = onboard LED (active LOW on most modules)")
    log("system", "expected: toggle every 500ms")
    run(blink)
}
