chip esp32

hardware {
    pin led: Output = 2
    pin motor: PWM = 4
    pin battery: Analog = 36
    pin temp: Analog = 39
}

task heartbeat() {
    every 1seconds {
        led.toggle()
    }
}

task motor_control() {
    every 1ms strict {
        motor.set_pwm(0)
    }
}

task telemetry() {
    every 30seconds {
        let bat = battery.read()
        let t = temp.read()
        mqtt.send_int("device/battery", bat)
        mqtt.send_int("device/temp", t)
    }
}

task cloud_report() {
    every 60seconds {
        http.post("https://api.example.com/data", "ok")
    }
}

main {
    wifi.connect("TestNetwork", "TestPassword")
    mqtt.connect("mqtt://broker.local")
    run(heartbeat, motor_control, telemetry, cloud_report)
}
