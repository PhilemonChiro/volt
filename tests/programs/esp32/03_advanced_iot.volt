chip esp32

hardware {
    pin led: Output = 2
    pin motor: PWM = 4
    pin battery: Analog = 36
    pin temp: Analog = 39
}

var heartbeat_count: int = 0
var motor_isr_count: int = 0
var telemetry_count: int = 0
var cloud_count: int = 0

task heartbeat {
    every 1seconds {
        led.toggle()
        heartbeat_count = heartbeat_count + 1
        log("heartbeat", "#" + heartbeat_count + " | heap=" + system.free_heap())
    }
}

task motor_control {
    every 1ms strict {
        motor.set_pwm(0)
        motor_isr_count = motor_isr_count + 1
    }
}

task telemetry {
    every 30seconds {
        let bat = battery.read()
        let t = temp.read()
        telemetry_count = telemetry_count + 1
        log("telemetry", "#" + telemetry_count + " bat=" + bat + " temp=" + t)
        mqtt.send_int("device/battery", bat)
        mqtt.send_int("device/temp", t)
        log("telemetry", "mqtt sent ok")
    }
}

task cloud_report {
    every 60seconds {
        cloud_count = cloud_count + 1
        log("cloud", "#" + cloud_count + " posting to API")
        http.post("https://api.example.com/data", "ok")
        log("cloud", "http post done")
    }
}

task stats {
    every 10seconds {
        log("stats", "heartbeat=" + heartbeat_count + " isr=" + motor_isr_count + " telemetry=" + telemetry_count + " cloud=" + cloud_count)
        log("stats", "wifi=" + wifi.is_connected() + " heap=" + system.free_heap())
    }
}

setup {
    log("system", "=== ESP32 Advanced IoT Test ===")
    log("system", "tiers: heartbeat=background, motor=critical(1ms), telemetry=priority(mqtt), cloud=priority(http)")
    log("system", "connecting wifi...")
    wifi.connect("TestNetwork", "TestPassword")
    log("system", "connecting mqtt...")
    mqtt.connect("mqtt://broker.local")
    log("system", "starting tasks")
    run(heartbeat, motor_control, telemetry, cloud_report, stats)
}
