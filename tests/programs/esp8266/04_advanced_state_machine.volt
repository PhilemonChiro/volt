chip esp8266

hardware {
    pin led: Output = 2
    pin relay: Output = 4
    pin buzzer: Output = 14
}

var lock_toggles: int = 0
var blink_count: int = 0

machine DoorController {
    initial state locked {
        enter {
            relay.off()
            led.off()
            log("door", "STATE -> locked | relay=OFF led=OFF")
        }
        on unlock_cmd -> unlocked
    }

    state unlocked {
        enter {
            relay.on()
            led.on()
            lock_toggles = lock_toggles + 1
            log("door", "STATE -> unlocked #" + lock_toggles + " | relay=ON led=ON")
            log("door", "auto-lock in 10 seconds")
        }
        after 10seconds -> locked
        on lock_cmd -> locked
    }
}

task status_blink() {
    every 2seconds {
        buzzer.toggle()
        blink_count = blink_count + 1
        log("status", "blink #" + blink_count + " | lock_toggles=" + lock_toggles)
    }
}

task health() {
    every 10seconds {
        log("health", "lock_toggles=" + lock_toggles + " blinks=" + blink_count + " wifi=" + wifi.is_connected() + " heap=" + system.free_heap())
    }
}

main {
    log("system", "=== ESP8266 State Machine Test ===")
    log("system", "machine: DoorController (locked <-> unlocked)")
    log("system", "auto-lock after 10s in unlocked state")
    log("system", "pins: led=2, relay=4, buzzer=14")
    wifi.connect("DoorNet", "password")
    log("system", "starting tasks")
    run(status_blink, health)
}
