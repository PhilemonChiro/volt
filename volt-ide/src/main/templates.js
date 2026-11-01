// templates.js — the starters a new project begins from: small, generic
// skeletons, one per way of writing a Volt program (finished projects are
// under Examples). The New Project sheet previews them; createProject in
// main.js writes them. ESP32 pins; setup sits right after hardware.

const STARTERS = [
    { id: "empty", label: "Blank", desc: "Hardware and setup, ready to fill in", icon: "blank",
      source: () => `hardware {
    // pins and devices go here, e.g. pin led: Output = 2
}

setup {
    // runs once at power-on
    log("app", "started")
}
` },
    { id: "blink", label: "Blink", desc: "The smallest program: an LED that blinks", icon: "blink",
      source: () => `hardware {
    pin led: Output = 2
}

// on, off, on… twice a second
every 500ms {
    led.toggle()
}
` },
    { id: "events", label: "Button events", desc: "Do something each time an input changes", icon: "button",
      source: () => `hardware {
    pin led: Output = 2
    pin button: PullUpInput = 4 // a push button between GPIO 4 and GND
}

setup {
    led.off()
}

// runs once per press, not again while it's held
on button.is_pressed() debounce 50ms {
    led.toggle()
}
` },
    { id: "timers", label: "Timers", desc: "Work that repeats, each at its own pace", icon: "timer",
      source: () => `hardware {
    pin led: Output = 2
    pin sensor: Analog = 34
}

setup {
    log("app", "started")
}

// fast: blink to show it's alive
every 500ms {
    led.toggle()
}

// slow: read and report
every 5s {
    let value: int = sensor.read()
    log("sensor", "value {value}")
}
` },
    { id: "state-machine", label: "State machine", desc: "States, events and timed steps", icon: "states",
      source: () => `hardware {
    pin led: Output = 2
    pin button: PullUpInput = 4 // a push button between GPIO 4 and GND
}

setup {
    log("app", "started")
}

var start: bool = false

on button.is_pressed() debounce 50ms {
    start = true
}

machine app {
    initial state idle {
        enter { led.off() }
        on start -> running { start = false }
    }

    state running {
        enter { led.on() }
        after 5s -> idle
    }
}
` },
    { id: "network", label: "WiFi + MQTT", desc: "Connect, then publish on a schedule", icon: "wifi",
      source: () => `hardware {
    pin led: Output = 2
}

setup {
    wifi.connect("your-network", "your-password") or retry(10)
    mqtt.connect("mqtt://broker.local") or retry(5)
}

var count: int = 0

every 500ms { led.toggle() }

every 10s when wifi.is_connected() {
    count += 1
    mqtt.send_int("device/count", count)
}
` },
];

/** list() → [{id, label, desc, icon, source}]. */
function list() { return STARTERS.map(s => ({ id: s.id, label: s.label, desc: s.desc, icon: s.icon, source: s.source() })); }

/** source(id) → main.volt for a new project; Blink when the id is unknown. */
function source(id) { return (STARTERS.find(s => s.id === id) || STARTERS[1]).source(); }

module.exports = { list, source };
