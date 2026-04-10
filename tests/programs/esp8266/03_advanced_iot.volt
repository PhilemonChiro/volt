chip esp8266

hardware {
    pin led: Output = 2
    pin relay: Output = 4
    pin sensor_pin: Input = 5
}

var heartbeat_count: int = 0
var sensor_reads: int = 0
var mqtt_sends: int = 0
var push_count: int = 0
var sync_count: int = 0

task heartbeat() {
    every 1seconds {
        led.toggle()
        heartbeat_count = heartbeat_count + 1
        if heartbeat_count % 10 == 0 {
            log("heartbeat", "#" + heartbeat_count + " heap=" + system.free_heap())
        }
    }
}

task sensor_check() {
    every 5seconds {
        let val = sensor_pin.read()
        sensor_reads = sensor_reads + 1
        log("sensor", "#" + sensor_reads + " GPIO5=" + val)
        if val == 1 {
            relay.on()
            log("sensor", "relay ON (sensor HIGH)")
        } else {
            relay.off()
            log("sensor", "relay OFF (sensor LOW)")
        }
    }
}

task mqtt_report() {
    every 30seconds {
        mqtt_sends = mqtt_sends + 1
        log("mqtt", "#" + mqtt_sends + " sending status + sensor")
        mqtt.send_int("esp8266/status", 1)
        mqtt.send_int("esp8266/sensor", sensor_pin.read())
        log("mqtt", "send complete")
    }
}

task data_buffer() {
    every 10seconds {
        push_count = push_count + 1
        storage.push("readings", sensor_pin.read())
        log("storage", "push #" + push_count + " | buffered=" + storage.list_count("readings"))
    }
}

task sync() {
    every 60seconds {
        if wifi.is_connected() {
            sync_count = sync_count + 1
            log("sync", "#" + sync_count + " wifi connected, sending")
            mqtt.send_int("esp8266/alive", 1)
        } else {
            log("sync", "SKIP — wifi disconnected")
        }
    }
}

task health() {
    every 15seconds {
        log("health", "=== ESP8266 HEALTH ===")
        log("health", "  heartbeats=" + heartbeat_count)
        log("health", "  sensor_reads=" + sensor_reads)
        log("health", "  mqtt_sends=" + mqtt_sends)
        log("health", "  storage_pushes=" + push_count)
        log("health", "  cloud_syncs=" + sync_count)
        log("health", "  wifi=" + wifi.is_connected())
        log("health", "  heap=" + system.free_heap())
        log("health", "=====================")
    }
}

main {
    log("system", "=== ESP8266 Advanced IoT Test ===")
    log("system", "pins: led=2, relay=4, sensor=5")
    log("system", "tasks: heartbeat@1s, sensor@5s, mqtt@30s, buffer@10s, sync@60s, health@15s")
    log("system", "connecting wifi...")
    wifi.connect("HomeNet", "password")
    log("system", "connecting mqtt...")
    mqtt.connect("mqtt://192.168.1.100")
    log("system", "starting 6 tasks")
    run(heartbeat, sensor_check, mqtt_report, data_buffer, sync, health)
}
