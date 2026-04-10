chip esp32

hardware {
    pin led: Output = 2
    pin motor: PWM = 4
    pin battery: Analog = 36
}

task blink() {
    every 500ms {
        led.toggle()
    }
}

task motor_pid() {
    every 1ms strict {
        motor.set_pwm(0)
    }
}

task telemetry() {
    every 5seconds {
        mqtt.send_int("volt/battery", battery.read())
    }
}

main {
    wifi.connect("MyNetwork", "MyPassword")
    mqtt.connect("mqtt://broker.local")
    run(blink, motor_pid, telemetry)
}
