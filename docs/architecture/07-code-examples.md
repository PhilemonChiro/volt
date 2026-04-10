# Volt Code Examples

Three examples with increasing complexity demonstrating the language's capabilities.

---

## Example 1: Beginner — Smart LED with Button

**What it does:** LED toggles on button press with debounce, blinks when WiFi is connected, sends LED status over MQTT.

```volt
chip esp32

hardware {
    pin led: Output = 2
    pin button: Input.PullUp = 0
}

task blink_when_online() {
    every 1second {
        if wifi.is_connected() {
            led.toggle()
        }
    }
}

task button_handler() {
    on button.press() debounce 50ms {
        led.toggle()
        mqtt.send("home/led", led.is_on())
        log("LED is now: {led.is_on()}")
    }
}

main {
    wifi.connect("MyNet", "password")
    mqtt.connect("broker.local")
    run(blink_when_online, button_handler)
}
```

### Compiler Output

```
✓ GPIO 0 valid for Input — OK
✓ GPIO 2 valid for Output — OK
✓ GPIO 0 is strapping pin — NOTE: must be HIGH at boot (PullUp handles this)
✓ debounce 50ms — millis() tracking generated automatically
✓ led.is_on() returns bool — valid for mqtt.send() (auto-converts to "true"/"false")
✓ No ADC2/WiFi conflict

Memory: Flash 48 KB, RAM 66 KB (64K WiFi + 2K code), Free 262 KB
```

### Equivalent Arduino C (45 lines vs 25 lines Volt)

```c
#include <WiFi.h>
#include <PubSubClient.h>

const int LED_PIN = 2;
const int BUTTON_PIN = 0;
bool led_state = false;
unsigned long last_debounce = 0;
int last_button = HIGH;
unsigned long last_blink = 0;
WiFiClient espClient;
PubSubClient mqtt(espClient);

void setup() {
    Serial.begin(115200);
    pinMode(LED_PIN, OUTPUT);
    pinMode(BUTTON_PIN, INPUT_PULLUP);
    WiFi.begin("MyNet", "password");
    while (WiFi.status() != WL_CONNECTED) { delay(500); }
    mqtt.setServer("broker.local", 1883);
    mqtt.connect("esp32");
}

void loop() {
    mqtt.loop();
    if (WiFi.status() == WL_CONNECTED) {
        if (millis() - last_blink >= 1000) {
            last_blink = millis();
            led_state = !led_state;
            digitalWrite(LED_PIN, led_state);
        }
    }
    int reading = digitalRead(BUTTON_PIN);
    if (reading != last_button) {
        last_debounce = millis();
    }
    if ((millis() - last_debounce) > 50) {
        if (reading == LOW && last_button == HIGH) {
            led_state = !led_state;
            digitalWrite(LED_PIN, led_state);
            mqtt.publish("home/led", led_state ? "true" : "false");
            Serial.printf("LED is now: %s\n", led_state ? "true" : "false");
        }
    }
    last_button = reading;
}
```

---

## Example 2: Intermediate — Weather Station with Display and OTA

**What it does:** Reads BME280 sensor, shows on OLED display, sends to MQTT every 30 seconds, supports OTA firmware updates, handles remote commands.

```volt
chip esp32

hardware {
    i2c sensors = i2c(sda: 21, scl: 22, speed: 400.khz)

    sensor bme: BME280 on sensors at 0x76
    display oled: SSD1306 on sensors at 0x3C

    pin led: Output = 2
    pin battery: Analog = 36
}

struct Reading {
    temperature: float
    humidity: float
    pressure: float
    battery_pct: int
}

func read_all() -> Reading {
    return Reading {
        temperature: bme.temperature(),
        humidity: bme.humidity(),
        pressure: bme.pressure(),
        battery_pct: battery.read().map(0, 4095, 0, 100)
    }
}

func show_on_display(r: Reading) {
    oled.clear()
    oled.text(0, 0,  "Temp: {r.temperature:.1f} C")
    oled.text(0, 16, "Hum:  {r.humidity:.0f}%")
    oled.text(0, 32, "Pres: {r.pressure:.0f} hPa")
    oled.text(0, 48, "Batt: {r.battery_pct}%")
    oled.show()
}

task monitor() {
    every 30seconds {
        led.on()

        let data = read_all()
        show_on_display(data)

        mqtt.send("weather/temperature", data.temperature)
        mqtt.send("weather/humidity", data.humidity)
        mqtt.send("weather/pressure", data.pressure)
        mqtt.send("weather/battery", data.battery_pct)

        log("Temp={data.temperature:.1f} Hum={data.humidity:.0f} Batt={data.battery_pct}%")

        led.off()
    }
}

task handle_commands() {
    mqtt.on_receive("weather/command") { message in
        if message == "restart" {
            system.restart()
        }
        if message == "reading" {
            let data = read_all()
            mqtt.send("weather/instant", data.temperature)
        }
    }
}

main {
    wifi.connect("MyNet", "password")
    mqtt.connect("broker.local")
    ota.enable()

    oled.clear()
    oled.text(0, 24, "Connecting...")
    oled.show()

    run(monitor, handle_commands)
}
```

### Compiler Output

```
✓ I2C bus: 2 devices at 0x76, 0x3C — addresses unique, OK
✓ GPIO 36 is ADC1 — works with WiFi active, OK
✓ struct Reading: 13 bytes stack — OK
✓ battery.read().map() — Analog returns int, .map() valid on int
✓ OTA enabled — partition table requires ota_0 and ota_1 partitions

Memory: Flash 89 KB, RAM 78 KB, Free 250 KB

Power Estimate (30s cycle, light sleep between):
  Average: ~3.8 mA
  Battery life (2000mAh): ~21.9 days
```

---

## Example 3: Advanced — Solar-Powered Agricultural Sensor Network

**What it does:** LoRa sensor node reads soil moisture, temperature, light. Runs on solar + battery. Deep sleeps between readings. Adapts sleep duration based on battery level. Stores readings locally when gateway is unreachable. Full state machine for power management.

```volt
chip esp32

hardware {
    i2c env = i2c(sda: 21, scl: 22, speed: 100.khz)
    spi radio_bus = spi(mosi: 23, miso: 19, clk: 18, speed: 1.mhz)

    sensor soil: CapacitiveSoil on analog(36)
    sensor bme: BME280 on env at 0x76
    sensor light: BH1750 on env at 0x23

    radio lora: SX1262 on radio_bus cs: 5, reset: 14, busy: 27

    pin led: Output = 2
    pin solar_sense: Analog = 39
    pin battery_sense: Analog = 34
}

power {
    source: battery(3.7.v, 2000.mah)
    charging: solar
}

struct SensorPacket {
    node_id: int
    soil_moisture: int
    temperature: float
    humidity: float
    light_lux: float
    battery_mv: int
    solar_mv: int
}

func battery_voltage() -> int {
    return battery_sense.read().map(0, 4095, 0, 3300) * 2
}

func solar_voltage() -> int {
    return solar_sense.read().map(0, 4095, 0, 3300) * 2
}

func collect_data() -> SensorPacket {
    return SensorPacket {
        node_id: system.id,
        soil_moisture: soil.read().map(4095, 1500, 0, 100).clamp(0, 100),
        temperature: bme.temperature(),
        humidity: bme.humidity(),
        light_lux: light.lux(),
        battery_mv: battery_voltage(),
        solar_mv: solar_voltage()
    }
}

storage queue: list<SensorPacket> max: 48

machine PowerState {
    state normal {
        enter {
            log("Mode: normal")
        }
        on battery_voltage() < 3400 -> low_power
    }

    state low_power {
        enter {
            log("Mode: low power")
            led.off()
        }
        on battery_voltage() > 3500 -> normal
        on battery_voltage() < 3200 -> critical
    }

    state critical {
        enter {
            log("Mode: critical")
        }
        on battery_voltage() > 3300 -> low_power
    }
}

func sleep_duration() -> Duration {
    match(PowerState.current) {
        .normal   -> 10minutes
        .low_power -> 30minutes
        .critical  -> 1hour
    }
}

task main_cycle() {
    let data = collect_data()
    log("Soil:{data.soil_moisture}% Temp:{data.temperature:.1f}C Batt:{data.battery_mv}mV")

    let sent = lora.send(data) timeout 5seconds

    if sent {
        led.blink_once(100ms)

        while queue.has_items() {
            let old = queue.pop()
            lora.send(old) timeout 3seconds
        }
    } else {
        queue.push(data)
        log("Queued: {queue.count}/48")
    }

    PowerState.update()

    let sleep_time = sleep_duration()
    log("Sleeping {sleep_time}")
    deep_sleep(sleep_time)
}

main {
    main_cycle()
}
```

### Compiler Output

```
✓ I2C bus: 2 devices at 0x76, 0x23 — addresses unique, OK
✓ SPI bus: SX1262 CS=5, reset=14, busy=27 — no conflicts, OK
✓ GPIO 36, 39, 34 are ADC1 — work in deep sleep, OK
✓ GPIO 34 is input-only — Analog correct, OK

✓ State machine PowerState:
  ✓ All states reachable
  ✓ Voltage thresholds have hysteresis (3400/3500, 3200/3300) — good
  ✓ No dead-end states

✓ Storage queue: 48 × 24 bytes = 1,152 bytes in RTC memory
  ✓ Fits in RTC SLOW memory (8 KB)
  ✓ Survives deep_sleep()

✓ PowerState.current placed in RTC memory automatically
✓ No regular variables used across deep_sleep() boundary

Memory: Flash 112 KB, RAM 42 KB (no WiFi), RTC 1.3 KB / 8 KB, Free 286 KB

Power Estimate (normal mode):
  Wake: ~3 seconds, Deep sleep: 10 min @ 10 uA
  Average: ~0.12 mA
  Battery life: ~694 days (1.9 years)
  With solar: indefinite
```

---

## Comparison Table

| | Example 1 | Example 2 | Example 3 |
|--|-----------|-----------|-----------|
| **Volt lines** | 25 | 65 | 105 |
| **Equivalent C lines** | 45 | 250+ | 500+ |
| **Hardware checks** | Pin validation | I2C conflicts, ADC1 check | State machine, RTC placement, deep sleep safety |
| **Connectivity** | WiFi + MQTT | WiFi + MQTT + OTA | LoRa (no WiFi) |
| **Power** | Always on | Light sleep | Deep sleep + solar + battery state machine |
| **Data** | Simple values | Struct + display | Store-and-forward queue |
