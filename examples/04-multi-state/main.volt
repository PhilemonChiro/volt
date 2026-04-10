chip esp32

hardware {
    pin led: Output = 2
}

machine Pattern {
    var cycle = 0

    initial state fast {
        enter {
            log("fast mode")
        }
        after 3seconds -> slow {
            cycle = cycle + 1
        }
    }

    state slow {
        enter {
            log("slow mode")
        }
        after 5seconds -> pulse
    }

    state pulse {
        enter {
            log("pulse mode")
        }
        after 2seconds -> fast
    }
}

task blink() {
    every 200ms {
        led.toggle()
    }
}

task status() {
    var tick = 0
    every 1seconds {
        tick = tick + 1
        log("alive")
    }
}

main {
    run(blink, status)
}
