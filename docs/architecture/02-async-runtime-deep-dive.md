# Async Runtime Deep Dive

> **Status: IMPLEMENTED.** Three-tier scheduler running on ESP32. Advanced protothreads with transpiler-powered variable lifting, counter-based yield labels, and auto task classification. Verified with 500ms-precision timing test (29/29 perfect toggles).

## The Core Innovation

Embassy proved that async/await on bare metal is the future of embedded development (9K stars, fastest-growing embedded project). But Embassy requires Rust, which excludes 90%+ of embedded developers.

**Volt brings async to embedded in two ways:**
1. **For Volt language users:** `task`, `every`, `on` keywords — the transpiler generates the C coroutine code automatically. Users never see the machinery below.
2. **For C framework users:** The C macros described in this document provide async primitives directly.

This document covers the **internal C implementation** — what the transpiler generates under the hood. For the user-facing Volt syntax, see `06-volt-language-design.md`.

---

## 1. Why Async Matters for Embedded

### The Arduino Problem

```c
// Arduino: everything blocks. One task at a time.
void loop() {
    float temp = readSensor();    // Takes 50ms
    sendMQTT(temp);               // Takes 200ms, might timeout
    updateDisplay(temp);          // Takes 30ms
    delay(1000);                  // Everything stops for 1 second
    // Total: ~1.3 seconds per loop. LED can't blink independently.
}
```

### The RTOS Solution (ESP-IDF / Zephyr)

```c
// Correct but complex. Need to manage stacks, priorities, synchronization.
void sensor_task(void *arg) {
    while (1) {
        float temp = readSensor();
        xQueueSend(data_queue, &temp, portMAX_DELAY); // FreeRTOS API
        vTaskDelay(pdMS_TO_TICKS(1000));
    }
}

void mqtt_task(void *arg) {
    while (1) {
        float temp;
        xQueueReceive(data_queue, &temp, portMAX_DELAY);
        mqtt_publish(client, "temp", &temp); // What if this fails?
    }
}

void app_main() {
    xTaskCreate(sensor_task, "sensor", 4096, NULL, 5, NULL);
    xTaskCreate(mqtt_task, "mqtt", 8192, NULL, 4, NULL);
    // How much stack for each? Trial and error. Overflow = crash.
}
```

**Problems with RTOS tasks:**
- Must guess stack size per task (too small = crash, too large = waste)
- Priority inversion bugs are subtle and hard to debug
- Shared state requires mutexes/semaphores (deadlock risk)
- Context switching has overhead (~500 cycles on Cortex-M)
- FreeRTOS API is verbose and non-obvious

### The Async Solution (Our Framework)

```c
// Clean, intuitive, zero-overhead
async_task(sensor_task) {
    while (true) {
        float temp = await sensor_read(BME280);
        await mqtt_publish("home/temp", temp);
        await sleep_ms(1000);
    }
}

async_task(led_task) {
    while (true) {
        await gpio_toggle(LED);
        await sleep_ms(500);
    }
}

async_task(button_task) {
    while (true) {
        await button_pressed(BTN);
        LOG_INFO("Button pressed!");
    }
}

void app_main() {
    volt_run(sensor_task, led_task, button_task);
}
```

**Advantages:**
- No stack size guessing — stackless coroutines use zero extra stack
- No priority inversion — cooperative, explicit yield points
- No mutexes needed — only one task runs at a time (no preemption)
- No context switch overhead — state machine transformation at compile time
- Readable, natural control flow — looks like synchronous code

---

## 2. Implementation: Protothreads-Style (Recommended for v1)

### Core Mechanism

Based on Duff's device / computed labels. Each `await` becomes a resumption point in a switch statement.

```c
// volt/core/task.h

#include <stdint.h>

typedef enum {
    TASK_RUNNING,
    TASK_WAITING,
    TASK_DONE
} task_status_t;

typedef struct task {
    uint16_t _line;           // Current resumption point
    task_status_t status;
    uint32_t wake_at;         // Tick count to wake at
    const char *name;         // For debugging
} task_t;

// Core macros
#define TASK_BEGIN(t)          switch((t)->_line) { case 0:
#define TASK_END(t)            } (t)->status = TASK_DONE;

#define TASK_YIELD(t)          \
    do { (t)->_line = __LINE__; (t)->status = TASK_WAITING; return; \
         case __LINE__:; } while(0)

#define TASK_WAIT_UNTIL(t, cond) \
    do { (t)->_line = __LINE__; case __LINE__: \
         if (!(cond)) { (t)->status = TASK_WAITING; return; } } while(0)

#define TASK_SLEEP_MS(t, ms) \
    do { (t)->wake_at = volt_tick_ms() + (ms); \
         TASK_WAIT_UNTIL(t, volt_tick_ms() >= (t)->wake_at); } while(0)
```

### User-Facing API (Syntactic Sugar)

```c
// volt/core/async.h — what users actually write

// Define a task function
#define async_task(name) \
    static task_t _task_##name = {0}; \
    void name(task_t *_t)

// Await primitives
#define await(expr)         TASK_WAIT_UNTIL(_t, (expr))
#define sleep_ms(ms)        TASK_SLEEP_MS(_t, ms)
#define yield()             TASK_YIELD(_t)

// Task entry/exit
#define task_begin()        TASK_BEGIN(_t)
#define task_end()          TASK_END(_t)
```

### Complete Example

```c
#include "volt.h"

// Task 1: Read sensor every 5 seconds
async_task(sensor) {
    task_begin();
    
    bme280_init(I2C_PORT_0, 0x76);
    
    while (true) {
        bme280_data_t data;
        bme280_read(&data);
        
        LOG_INFO("temp=%.1f hum=%.1f", data.temperature, data.humidity);
        
        sleep_ms(5000);
    }
    
    task_end();
}

// Task 2: Blink LED every 500ms
async_task(blink) {
    task_begin();
    
    gpio_set_mode(LED_PIN, GPIO_OUTPUT);
    
    while (true) {
        gpio_toggle(LED_PIN);
        sleep_ms(500);
    }
    
    task_end();
}

// Task 3: Handle MQTT messages
async_task(comms) {
    task_begin();
    
    wifi_connect("MyNetwork", "password");
    await(wifi_is_connected());
    
    mqtt_t *m = mqtt_connect("broker.example.com");
    await(mqtt_is_connected(m));
    
    while (true) {
        mqtt_publish(m, "sensor/temp", last_temp_str);
        sleep_ms(10000);
    }
    
    task_end();
}

void app_main(void) {
    volt_init();
    volt_run(sensor, blink, comms, NULL);
}
```

### Limitations of Protothreads-Style

1. **Cannot use local variables across await/sleep points** — they lose their value when the function returns. Solution: use `static` locals or task context structs.

```c
// WRONG — 'count' resets each time
async_task(counter) {
    task_begin();
    int count = 0;        // Reset every resume!
    while (true) {
        count++;          // Always 1
        sleep_ms(1000);
    }
    task_end();
}

// CORRECT — static persists
async_task(counter) {
    task_begin();
    static int count = 0;  // Persists across resumes
    while (true) {
        count++;
        sleep_ms(1000);
    }
    task_end();
}
```

2. **Cannot use switch statements inside tasks** — conflicts with Duff's device. Solution: use if/else chains or extract to a separate function.

3. **No nested await** — can't `await` inside a called function (only top-level). Solution: macro-based composition or flatten the logic.

Document these limitations clearly. Experienced devs will understand the tradeoff. Beginners won't hit them in simple projects.

---

## 3. Scheduler

### Round-Robin Cooperative Scheduler

```c
// volt/core/scheduler.c

#define MAX_TASKS 16

typedef void (*task_func_t)(task_t *);

static struct {
    task_func_t func;
    task_t *ctx;
} task_list[MAX_TASKS];

static uint8_t task_count = 0;

void volt_add_task(task_func_t func, task_t *ctx) {
    task_list[task_count].func = func;
    task_list[task_count].ctx = ctx;
    task_count++;
}

void volt_run_loop(void) {
    while (true) {
        bool all_idle = true;
        
        for (int i = 0; i < task_count; i++) {
            task_t *t = task_list[i].ctx;
            
            if (t->status == TASK_DONE) continue;
            
            // Check if sleeping task should wake
            if (t->wake_at > 0 && volt_tick_ms() < t->wake_at) continue;
            
            t->status = TASK_RUNNING;
            task_list[i].func(t);
            
            if (t->status == TASK_RUNNING) {
                all_idle = false;
            }
        }
        
        if (all_idle) {
            // All tasks waiting — enter low-power idle
            volt_idle();  // Platform-specific: light sleep, WFI, etc.
        }
    }
}
```

### Power Management Integration

When all tasks are waiting (sleeping or blocked on I/O), the scheduler automatically enters the lowest possible power state:

```c
// targets/esp32/power.c
void volt_idle(void) {
    uint32_t next_wake = find_earliest_wake_time();
    uint32_t sleep_ms = next_wake - volt_tick_ms();
    
    if (sleep_ms > 10) {
        // Worth entering light sleep
        esp_sleep_enable_timer_wakeup(sleep_ms * 1000);
        esp_light_sleep_start();
    } else {
        // Just wait for interrupt
        __WFI();
    }
}
```

---

## 4. Inter-Task Communication

### Event Channels (Zero-Copy)

```c
// Typed event channel — compile-time checked
VOLT_CHANNEL(sensor_data, bme280_data_t, 4); // Buffer 4 items

// Producer task
async_task(sensor) {
    task_begin();
    while (true) {
        bme280_data_t data;
        bme280_read(&data);
        channel_send(&sensor_data, &data);  // Non-blocking if space
        sleep_ms(5000);
    }
    task_end();
}

// Consumer task
async_task(display) {
    task_begin();
    while (true) {
        bme280_data_t data;
        await(channel_receive(&sensor_data, &data));
        display_show_temp(data.temperature);
    }
    task_end();
}
```

### Signals (Simple Notifications)

```c
VOLT_SIGNAL(button_pressed);

async_task(button_handler) {
    task_begin();
    while (true) {
        await(signal_wait(&button_pressed));
        LOG_INFO("Button!");
    }
    task_end();
}

// From ISR or another task:
signal_raise(&button_pressed);
```

---

## 5. Advanced Protothreads (Transpiler-Powered)

Traditional protothreads have three limitations. Our transpiler eliminates all of them.

### Limitation 1: Local variables reset across yields → Transpiler auto-lifts

```volt
// User writes normal variables:
task monitor() {
    let count = 0
    every 1.second {
        count = count + 1
        log("Reading #{count}")
    }
}
```

```c
// Transpiler generates — count lifted to context struct:
typedef struct { int count; } monitor_ctx_t;
static monitor_ctx_t _monitor_ctx = { .count = 0 };

static void monitor_task(task_t *_t) {
    monitor_ctx_t *ctx = &_monitor_ctx;
    switch(_t->_line) { case 0:
    while (1) {
        ctx->count = ctx->count + 1;  // persists across yield
        log_info("main", "Reading #%d", ctx->count);
        _t->wake_at = volt_tick_ms() + 1000;
        _t->_line = __LINE__; return; case __LINE__:
        if (volt_tick_ms() < _t->wake_at) return;
    }
    }
}
```

The analyzer determines which variables cross yield points. Only those are lifted. Variables that don't cross yields stay as normal C locals (zero overhead).

### Limitation 2: Switch conflicts → Transpiler uses if/else

Volt's `match` expression compiles to if/else chains, never C `switch`. The `switch` keyword is reserved exclusively for the protothread machinery. No conflict possible.

### Limitation 3: Can't yield from nested calls → Transpiler inlines

Functions containing yield points are inlined at the call site during code generation. Each inline gets its own context struct instance.

### Memory comparison

| | Advanced Protothreads | FreeRTOS Tasks |
|--|----------------------|----------------|
| Per task | 2 bytes + lifted vars (~10-50 bytes typical) | 2,048 - 8,192 bytes |
| 10 tasks | ~200-500 bytes | 20,000 - 80,000 bytes |
| Stack overflow? | Impossible (no stack) | Common crash |
| Context switch | ~10 cycles | ~500 cycles |

### Robustness

- Protothreads core: battle-tested since 2005 (Contiki OS, billions of devices)
- Variable lifting: same technique as Rust async/await and C++20 coroutines
- Generated C is readable and inspectable via `volt build --show-generated`
- `#line` directives map errors back to `.volt` source

---

## 6. Comparison with Embassy

| Aspect | Embassy (Rust) | Volt |
|--------|---------------|------|
| User language | Rust | Volt DSL (typed, hardware-aware) |
| Internal async | Rust compiler state machines | Transpiler-powered protothreads |
| Memory safety | Rust ownership (compile-time) | Volt type checker (compile-time) |
| Hardware awareness | None (programmer responsibility) | Pin validation, ADC2/WiFi detection |
| Local variables across yield | Compiler handles | Transpiler auto-lifts to context struct |
| Stack per task | Zero | Zero + small context struct |
| Performance | Native | Native (both compile to zero-overhead C/machine code) |
| Target audience | Rust developers (~10% of embedded) | All developers (~100%) |

**Key difference:** Embassy is technically excellent but requires Rust. Volt achieves similar async ergonomics through transpiler-powered code generation, accessible to anyone who can read Python-like syntax.

---

## 7. Escape Hatch for Hard Real-Time

For code requiring true preemption or ISR-level timing:

```volt
raw {
    void IRAM_ATTR motor_isr(void *arg) {
        // Direct register access, runs in ISR context
        // Not limited by cooperative scheduling
        GPIO.out_w1ts = (1 << 4);
    }
}
```

`raw {}` blocks pass C code through verbatim. The transpiler does not validate their contents. This allows mixing Volt's ergonomic tasks with time-critical ISR code when needed.
