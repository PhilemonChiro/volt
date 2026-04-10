chip esp32

hardware {
    pin led: Output = 2
}

machine Blinker {
    initial state off {
        enter {
            led.off()
        }
        after 500ms -> on
    }
    state on {
        enter {
            led.on()
        }
        after 500ms -> off
    }
}
