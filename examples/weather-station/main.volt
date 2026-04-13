/* ============================================================
   IoT Weather Station — ESP32

   Reads environment sensors, publishes to MQTT, buffers data
   offline, and reports health metrics.

   Demonstrates: setup, tasks, channels, shared vars, storage,
   WiFi, MQTT, string interpolation, state machine.

   Hardware:
     GPIO2  = status LED
     GPIO32 = soil moisture (ADC)
     GPIO33 = light level (ADC)
     GPIO36 = temperature (ADC — thermistor)
   ============================================================ */

chip esp32

hardware {
    pin led: Output = 2
    pin soil: Analog = 32
    pin light: Analog = 33
    pin temperature: Analog = 36
}

storage boot_count: int = 0
storage total_readings: int = 0

/* Latest sensor values — shared across tasks automatically */
var soil_pct: int = 0
var light_lux: int = 0
var temp_raw: int = 0

/* Sensor data channel: sampler → publisher */
channel readings: int[16]

/* ---- Sensor sampler: reads all sensors periodically ---- */
task sampler {
    every 10s {
        /* Read raw ADC values (0-4095) */
        let s = soil.read()
        let l = light.read()
        let t = temperature.read()

        /* Convert to meaningful units */
        soil_pct = s * 100 / 4095
        light_lux = l * 1000 / 4095
        temp_raw = t

        total_readings += 1

        /* Queue for publishing */
        readings.send(soil_pct)

        log("sensor", "soil={soil_pct}% light={light_lux}lux temp_raw={temp_raw}")
    }
}

/* ---- MQTT publisher: sends data when WiFi is available ---- */
task publisher {
    every 30s {
        if wifi.is_connected() {
            /* Publish latest values */
            mqtt.send_int("weather/soil", soil_pct)
            mqtt.send_int("weather/light", light_lux)
            mqtt.send_int("weather/temp", temp_raw)
            mqtt.send_int("weather/readings", total_readings)

            log("mqtt", "published: soil={soil_pct} light={light_lux} temp={temp_raw}")

            /* Drain buffered data if any */
            while readings.has_data() {
                let val = readings.receive()
                mqtt.send_int("weather/soil_buffered", val)
            }
        } else {
            /* Offline: buffer to storage for later */
            storage.push("offline_soil", soil_pct)
            log("mqtt", "offline — buffered soil={soil_pct}")
        }
    }
}

/* ---- Data persistence: save stats to flash periodically ---- */
task persist {
    every 60s {
        storage.save("boot_count", boot_count)
        storage.save("total_readings", total_readings)
        log("storage", "saved: boots={boot_count} readings={total_readings}")
    }
}

/* ---- Health monitoring ---- */
task health {
    every 30s {
        let heap = system.free_heap()
        let up = system.uptime()
        let rssi = wifi.get_rssi()
        let ip = wifi.get_ip()

        log("health", "uptime={up}s heap={heap} wifi_rssi={rssi}dBm")
        log("health", "ip={ip} boots={boot_count} readings={total_readings}")
        log("health", "soil={soil_pct}% light={light_lux}lux buffered={readings.count()}")
    }
}

/* ---- LED heartbeat: visual feedback that system is alive ---- */
task heartbeat {
    every 1s {
        led.toggle()
    }
}

/* ---- Connection state machine ---- */
machine ConnectionState {
    var retry_count: int = 0

    initial state connecting {
        enter {
            log("conn", "connecting to WiFi...")
            led.on()
        }
        after 10s -> checking
    }

    state checking {
        enter {
            if wifi.is_connected() {
                log("conn", "WiFi connected!")
            }
            retry_count += 1
        }
        after 5s -> connected
    }

    state connected {
        enter {
            log("conn", "online — publishing data")
        }
        after 60s -> checking
    }
}

/* ---- Startup ---- */
setup {
    boot_count += 1

    log("boot", "=== IoT Weather Station ===")
    log("boot", "boot #{boot_count}, total readings: {total_readings}")
    log("boot", "sensors: soil=GPIO32 light=GPIO33 temp=GPIO36")

    /* Connect to network */
    wifi.connect("WeatherNet", "password123")
    mqtt.connect("mqtt://192.168.1.100")

    log("boot", "WiFi + MQTT connecting...")
}
