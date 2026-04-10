chip esp8266

hardware {
    pin led: Output = 2
    pin relay: Output = 4
    pin sensor_pin: Input = 5
}

task heartbeat() {
    every 1seconds {
        led.toggle()
    }
}

task sensor_check() {
    every 5seconds {
        let val = sensor_pin.read()
        if val == 1 {
            relay.on()
        } else {
            relay.off()
        }
    }
}

task mqtt_report() {
    every 30seconds {
        mqtt.send_int("esp8266/status", 1)
        mqtt.send_int("esp8266/sensor", sensor_pin.read())
    }
}

task data_buffer() {
    every 10seconds {
        storage.push("readings", sensor_pin.read())
    }
}

task sync() {
    every 60seconds {
        if wifi.is_connected() {
            mqtt.send_int("esp8266/alive", 1)
        }
    }
}

main {
    wifi.connect("HomeNet", "password")
    mqtt.connect("mqtt://192.168.1.100")
    run(heartbeat, sensor_check, mqtt_report, data_buffer, sync)
}
