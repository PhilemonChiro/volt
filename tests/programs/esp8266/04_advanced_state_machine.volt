chip esp8266

hardware {
    pin led: Output = 2
    pin relay: Output = 4
    pin buzzer: Output = 14
}

machine DoorController {
    initial state locked {
        enter {
            relay.off()
            led.off()
        }
        on unlock_cmd -> unlocked
    }

    state unlocked {
        enter {
            relay.on()
            led.on()
        }
        after 10seconds -> locked
        on lock_cmd -> locked
    }
}

task status_blink() {
    every 2seconds {
        buzzer.toggle()
    }
}

main {
    wifi.connect("DoorNet", "password")
    run(status_blink)
}
