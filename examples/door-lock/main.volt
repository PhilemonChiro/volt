/* ============================================================
   Smart Door Lock — ESP32

   A WiFi-connected door lock with keypad, buzzer alerts,
   auto-lock timer, and remote MQTT control.

   Demonstrates: state machines with guards, multiple tasks,
   channels, storage persistence, MQTT remote control.

   Hardware:
     GPIO2  = status LED (green)
     GPIO4  = lock relay
     GPIO15 = keypad button (simulate code entry)
     GPIO18 = buzzer (PWM)
   ============================================================ */

chip esp32

hardware {
    pin led: Output = 2
    pin relay: Output = 4
    pin button: PullUpInput = 15
    pin buzzer: PWM = 18
}

storage total_unlocks: int = 0
storage failed_attempts: int = 0

/* Access control state — shared across tasks */
var is_locked: int = 1
var attempt_count: int = 0
var alarm_active: int = 0

/* State machine event flags */
var unlock_cmd: bool = false
var lock_cmd: bool = false

/* Command channel: button handler → lock controller */
channel lock_commands: int

/* ---- Button handler: detects press patterns ---- */
task keypad {
    var last: int = 1
    var press_count: int = 0
    var last_press_time: int = 0

    every 30ms {
        let state = button.read()
        if state == 0 {
            if last == 1 {
                press_count += 1
                last_press_time = system.uptime()

                /* 3 presses = unlock command */
                if press_count >= 3 {
                    lock_commands.send(1)
                    press_count = 0
                    log("keypad", "unlock code entered")
                }
            }
        }
        last = state

        /* Reset press count after 2 seconds of no activity */
        let now = system.uptime()
        if now - last_press_time > 2 {
            if press_count > 0 {
                if press_count < 3 {
                    lock_commands.send(0)
                    log("keypad", "wrong code: {press_count} presses (need 3)")
                }
                press_count = 0
            }
        }
    }
}

/* ---- Lock state machine ---- */
machine DoorLock {
    var auto_lock_timer: int = 0

    initial state locked {
        enter {
            relay.off()
            led.off()
            buzzer.set_pwm(0)
            is_locked = 1
            log("lock", "LOCKED")
            mqtt.send_int("door/status", 0)
        }
        on unlock_cmd -> unlocked
    }

    state unlocked {
        enter {
            relay.on()
            led.on()
            is_locked = 0
            total_unlocks += 1
            auto_lock_timer = 0
            log("lock", "UNLOCKED (total: {total_unlocks})")
            mqtt.send_int("door/status", 1)

            /* Short beep to confirm */
            buzzer.set_pwm(100)
        }
        exit {
            buzzer.set_pwm(0)
        }
        on lock_cmd -> locked
        after 30s -> locked
    }

    state alert {
        enter {
            buzzer.set_pwm(200)
            alarm_active = 1
            log("lock", "ALERT — too many failed attempts!")
            mqtt.send_int("door/alert", 1)
        }
        exit {
            buzzer.set_pwm(0)
            alarm_active = 0
            attempt_count = 0
            mqtt.send_int("door/alert", 0)
        }
        after 60s -> locked
    }
}

/* ---- Command processor: reads button events, drives state machine ---- */
task command_processor {
    on lock_commands.has_data() {
        let cmd = lock_commands.receive()
        if cmd == 1 {
            /* Correct code — unlock */
            unlock_cmd = true
            attempt_count = 0
        } else {
            /* Wrong code — count failures */
            attempt_count += 1
            failed_attempts += 1
            log("security", "failed attempt #{attempt_count} (total: {failed_attempts})")

            /* 3 wrong attempts → alert */
            if attempt_count >= 3 {
                log("security", "LOCKOUT — triggering alert")
            }

            /* Quick error beep */
            buzzer.set_pwm(255)
            sleep(200ms)
            buzzer.set_pwm(0)
        }
    }
}

/* ---- MQTT remote control ---- */
task remote_control {
    every 5s {
        if wifi.is_connected() {
            /* Publish current state */
            mqtt.send_int("door/locked", is_locked)
            mqtt.send_int("door/attempts", attempt_count)
            mqtt.send_int("door/alarm", alarm_active)
        }
    }
}

/* ---- Health monitoring ---- */
task health {
    every 30s {
        let heap = system.free_heap()
        let up = system.uptime()

        log("health", "uptime={up}s heap={heap}")
        log("health", "locked={is_locked} unlocks={total_unlocks} failed={failed_attempts}")

        /* Save stats periodically */
        storage.save("total_unlocks", total_unlocks)
        storage.save("failed_attempts", failed_attempts)
    }
}

/* ---- Startup ---- */
setup {
    log("boot", "=== Smart Door Lock ===")
    log("boot", "unlocks: {total_unlocks}, failed: {failed_attempts}")
    log("boot", "press button 3x within 2s to unlock")

    wifi.connect("HomeNet", "password")
    mqtt.connect("mqtt://192.168.1.100")
}
