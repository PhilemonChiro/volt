chip esp32

hardware {
    pin green: Output = 23
    pin red: Output = 22
    pin yellow: Output = 21
}

task blink_red {
    every 100ms {
        red.toggle()
    }
}

task blink_green {
    every 400ms {
        green.toggle()
    }
}

task blink_yellow {
    every 600ms {
        yellow.toggle()
    }
}
