# Firmware Engineering Patterns & Techniques

## Internal C implementation details for the Volt framework

> **Note:** This document covers the C code UNDERNEATH Volt. Users writing `.volt` files never see this — the transpiler generates it automatically. This is for framework developers and contributors who need to understand what the transpiler generates and why.
>
> For the user-facing Volt language syntax, see `06-volt-language-design.md`.

---

## 1. Coroutine Implementation — Our Async Engine

### 1.1 The Technique: Protothreads (Duff's Device)

Our async runtime uses `switch(__LINE__)`/`case __LINE__:` to create resumable functions. This exploits the fact that C `case` labels can appear inside sub-blocks of their enclosing `switch`.

**The raw mechanism:**

```c
// Before macro expansion:
async_task(blink) {
    task_begin();
    while (true) {
        gpio_toggle(LED);
        sleep_ms(500);
    }
    task_end();
}

// After macro expansion:
void blink(task_t *_t) {
    switch(_t->_line) { case 0:    // task_begin()
    while (true) {
        gpio_toggle(LED);
        _t->wake_at = volt_tick_ms() + 500;           // sleep_ms(500) part 1
        _t->_line = 42; _t->status = TASK_WAITING; return;  // yield
        case 42:                                        // resume point
        if (volt_tick_ms() < _t->wake_at) { _t->status = TASK_WAITING; return; }
    }
    } _t->status = TASK_DONE;     // task_end()
}
```

Each call to `blink(&task)` resumes at the last saved `case` label. The scheduler calls each task function repeatedly.

### 1.2 Available Coroutine Techniques

| Technique | Stack Per Task | Local Vars Across Yield | switch OK? | Portability | Best For |
|-----------|---------------|------------------------|-----------|-------------|----------|
| **Protothreads** (switch/case) | 0 bytes | No (use static) | No | Any C compiler | Our primary approach |
| **Computed goto** (GCC) | 0 bytes | No (use static) | **Yes** | GCC/Clang only | Alternative for complex tasks |
| **setjmp/longjmp** | 512-4096 bytes | Yes | Yes | Most compilers | Tasks needing nested yields |
| **s_task** library | Configurable | Yes | Yes | ARM, RISC-V, AVR | If we need stackful later |

### 1.3 Protothreads Limitations & Workarounds

**Limitation 1: No local variables across yield points**
```c
// BROKEN — count resets on every resume
async_task(counter) {
    task_begin();
    int count = 0;
    while (true) { count++; sleep_ms(1000); }
    task_end();
}

// FIX — use static
async_task(counter) {
    task_begin();
    static int count = 0;
    while (true) { count++; sleep_ms(1000); }
    task_end();
}

// FIX — use task context struct
typedef struct { int count; } counter_ctx_t;
static counter_ctx_t counter_ctx;
// Access as counter_ctx.count
```

**Limitation 2: No switch statements inside task body**
```c
// BROKEN — conflicts with outer switch
async_task(handler) {
    task_begin();
    switch(event) { case 1: ... }  // compile error
    task_end();
}

// FIX — use if/else
async_task(handler) {
    task_begin();
    if (event == 1) { ... }
    else if (event == 2) { ... }
    task_end();
}

// FIX — extract to separate function
static void handle_event(int event) {
    switch(event) { case 1: ... }  // fine here
}
async_task(handler) {
    task_begin();
    handle_event(event);
    task_end();
}
```

**Limitation 3: Cannot yield from a called function**
```c
// BROKEN — await only works at top level
void do_work(task_t *t) {
    sleep_ms(100);  // expands to switch/case — won't compile
}

// FIX — inline or use child protothreads
```

### 1.4 Computed Goto Alternative

For tasks that need `switch` statements, we offer a GCC-only alternative:

```c
#define TASK_BEGIN_GOTO     static void *_state = NULL; if (_state) goto *_state;
#define TASK_YIELD_GOTO     do { _state = &&_label_##__LINE__; return; \
                            _label_##__LINE__:; } while(0)
#define TASK_END_GOTO       _state = NULL;
```

This allows `switch` statements in the body but requires GCC or Clang.

---

## 2. Memory Patterns

### 2.1 Ring Buffer (Lock-Free SPSC)

The fundamental ISR-to-main communication structure:

```c
typedef struct {
    uint8_t *buf;
    size_t   size;        // must be power of 2 for fast modulo
    volatile size_t head; // written by producer (ISR)
    volatile size_t tail; // written by consumer (main loop)
} ringbuf_t;

static inline bool ringbuf_put(ringbuf_t *rb, uint8_t byte) {
    size_t next = (rb->head + 1) & (rb->size - 1);  // fast modulo
    if (next == rb->tail) return false;  // full
    rb->buf[rb->head] = byte;
    rb->head = next;
    return true;
}

static inline bool ringbuf_get(ringbuf_t *rb, uint8_t *byte) {
    if (rb->head == rb->tail) return false;  // empty
    *byte = rb->buf[rb->tail];
    rb->tail = (rb->tail + 1) & (rb->size - 1);
    return true;
}
```

**Lock-free safety:** Producer only writes `head`, consumer only writes `tail`. Safe on single-core and on ESP32's dual-core with natural memory ordering on Xtensa.

### 2.2 Memory Pool (Fixed-Size Block Allocator)

O(1) alloc/free, zero fragmentation:

```c
typedef struct pool {
    void    *free_list;
    uint8_t *buffer;
    size_t   block_size;
    size_t   count;
} pool_t;

#define POOL_DEFINE(name, type, n) \
    static uint8_t _pool_buf_##name[sizeof(type) * (n)]; \
    static pool_t name = { NULL, _pool_buf_##name, sizeof(type), (n) }

void pool_init(pool_t *p) {
    p->free_list = p->buffer;
    for (size_t i = 0; i < p->count - 1; i++) {
        void **block = (void **)(p->buffer + i * p->block_size);
        *block = p->buffer + (i + 1) * p->block_size;
    }
    void **last = (void **)(p->buffer + (p->count - 1) * p->block_size);
    *last = NULL;
}

void *pool_alloc(pool_t *p) {
    if (!p->free_list) return NULL;
    void *block = p->free_list;
    p->free_list = *(void **)block;
    return block;
}

void pool_free(pool_t *p, void *block) {
    *(void **)block = p->free_list;
    p->free_list = block;
}
```

### 2.3 Static-Only Pattern (No malloc)

```c
// All buffers declared at compile time
static uint8_t uart_rx[256];
static uint8_t mqtt_buf[1024];
static sensor_data_t readings[32];

// Compile-time size validation
_Static_assert(sizeof(mqtt_buf) >= MQTT_MAX_PACKET_SIZE,
               "MQTT buffer too small");

// Stack usage: use -fstack-usage flag during build
// Runtime: FreeRTOS uxTaskGetStackHighWaterMark()
```

---

## 3. Event System

### 3.1 Typed Event Queue

```c
typedef struct {
    uint8_t  type;
    uint8_t  source;
    uint16_t param;
    union {
        uint32_t u32;
        float    f32;
        void    *ptr;
    } data;
} event_t;

#define EVENT_QUEUE_SIZE 32  // must be power of 2

static event_t event_queue[EVENT_QUEUE_SIZE];
static volatile uint8_t eq_head, eq_tail;

// Post from ISR (lock-free)
bool IRAM_ATTR event_post_isr(event_t evt) {
    uint8_t next = (eq_head + 1) & (EVENT_QUEUE_SIZE - 1);
    if (next == eq_tail) return false;
    event_queue[eq_head] = evt;
    eq_head = next;
    return true;
}

// Consume in main loop
bool event_poll(event_t *evt) {
    if (eq_head == eq_tail) return false;
    *evt = event_queue[eq_tail];
    eq_tail = (eq_tail + 1) & (EVENT_QUEUE_SIZE - 1);
    return true;
}
```

### 3.2 Channel (Inter-Task Communication)

```c
#define VOLT_CHANNEL(name, type, depth) \
    static type _chan_buf_##name[depth]; \
    static volatile uint8_t _chan_head_##name, _chan_tail_##name; \
    static inline bool name##_send(const type *item) { \
        uint8_t next = (_chan_head_##name + 1) % (depth); \
        if (next == _chan_tail_##name) return false; \
        _chan_buf_##name[_chan_head_##name] = *item; \
        _chan_head_##name = next; \
        return true; \
    } \
    static inline bool name##_recv(type *item) { \
        if (_chan_head_##name == _chan_tail_##name) return false; \
        *item = _chan_buf_##name[_chan_tail_##name]; \
        _chan_tail_##name = (_chan_tail_##name + 1) % (depth); \
        return true; \
    } \
    static inline bool name##_available(void) { \
        return _chan_head_##name != _chan_tail_##name; \
    }

// Usage:
VOLT_CHANNEL(sensor_data, float, 8);  // 8-deep float channel

// Producer task:
float temp = 23.5f;
sensor_data_send(&temp);

// Consumer task:
float val;
if (sensor_data_recv(&val)) { ... }
```

---

## 4. HAL Design

### 4.1 Three-Layer Architecture (Following ESP-IDF)

```
┌──────────────────────────────────────┐
│  Volt API (user-facing)             │  gpio_write(LED, HIGH)
│  Simple, safe, documented            │
├──────────────────────────────────────┤
│  HAL Implementation (per chip)       │  Maps Volt API → vendor API
│  Thread-safe, error-handled          │  Uses ESP-IDF driver underneath
├──────────────────────────────────────┤
│  Vendor SDK (ESP-IDF)                │  esp_gpio_set_level(pin, 1)
│  Register access, IRQs, DMA         │
└──────────────────────────────────────┘
```

### 4.2 Interface Pattern (Function Pointer Table)

For chip-agnostic drivers (sensors, displays) that work across targets:

```c
// hal/i2c_interface.h
typedef struct {
    int (*init)(void *ctx, uint8_t sda, uint8_t scl, uint32_t freq);
    int (*write)(void *ctx, uint8_t addr, const uint8_t *data, size_t len);
    int (*read)(void *ctx, uint8_t addr, uint8_t *data, size_t len);
    int (*write_read)(void *ctx, uint8_t addr,
                      const uint8_t *wr, size_t wr_len,
                      uint8_t *rd, size_t rd_len);
} i2c_interface_t;

// Driver uses the interface — chip-agnostic
int bme280_init(const i2c_interface_t *i2c, void *i2c_ctx, uint8_t addr) {
    uint8_t chip_id;
    uint8_t reg = 0xD0;
    i2c->write_read(i2c_ctx, addr, &reg, 1, &chip_id, 1);
    if (chip_id != 0x60) return -1;
    return 0;
}
```

---

## 5. Coding Discipline

### 5.1 The Three Sacred Keywords

**`static`** — Every function and variable is `static` unless it MUST be visible outside its file.

**`const`** — Every pointer parameter that won't be modified is `const`. Every lookup table is `const`.

**`volatile`** — Every variable shared with an ISR or hardware register.

```c
// Correct patterns:
static volatile uint32_t g_tick_count;           // ISR-shared
static const uint8_t lookup_table[256] = { ... }; // ROM-able
static void helper_function(void);                // file-private

void send_data(const uint8_t *data, size_t len);  // won't modify data
```

### 5.2 No Dynamic Allocation in Core

```c
// NEVER in framework core:
void *p = malloc(size);     // fragmentation, non-deterministic
char *s = strdup(str);      // hidden malloc

// ALWAYS:
static uint8_t buffer[MAX_SIZE];                  // static
pool_t *pool = pool_alloc(&msg_pool);             // pool
uint8_t *arena_buf = arena_alloc(&scratch, 128, 4); // arena
```

### 5.3 Error Handling

```c
typedef enum {
    VOLT_OK = 0,
    VOLT_ERR_INVALID_ARG = -1,
    VOLT_ERR_NO_MEM = -2,
    VOLT_ERR_TIMEOUT = -3,
    VOLT_ERR_NOT_FOUND = -4,
    VOLT_ERR_NOT_SUPPORTED = -5,
    VOLT_ERR_IO = -6,
} volt_err_t;

// Every function returns volt_err_t
// Check at boundaries, propagate internally:
volt_err_t bme280_read(bme280_data_t *data) {
    volt_err_t err = i2c_read_reg(BME280_ADDR, 0xF7, raw, 8);
    if (err != VOLT_OK) return err;
    // ... process data ...
    return VOLT_OK;
}
```

---

## 6. Logging Architecture

### 6.1 Compile-Time Strippable Logging

```c
// Log levels compiled out below threshold — zero cost
#define LOG_LEVEL_NONE  0
#define LOG_LEVEL_ERROR 1
#define LOG_LEVEL_WARN  2
#define LOG_LEVEL_INFO  3
#define LOG_LEVEL_DEBUG 4

#ifndef VOLT_LOG_LEVEL
#define VOLT_LOG_LEVEL LOG_LEVEL_INFO
#endif

#define LOG_ERROR(tag, fmt, ...) \
    do { if (VOLT_LOG_LEVEL >= LOG_LEVEL_ERROR) \
        volt_log(LOG_LEVEL_ERROR, tag, fmt, ##__VA_ARGS__); } while(0)

#define LOG_INFO(tag, fmt, ...) \
    do { if (VOLT_LOG_LEVEL >= LOG_LEVEL_INFO) \
        volt_log(LOG_LEVEL_INFO, tag, fmt, ##__VA_ARGS__); } while(0)

#define LOG_DEBUG(tag, fmt, ...) \
    do { if (VOLT_LOG_LEVEL >= LOG_LEVEL_DEBUG) \
        volt_log(LOG_LEVEL_DEBUG, tag, fmt, ##__VA_ARGS__); } while(0)
```

### 6.2 Colored Terminal Output

```c
void volt_log(int level, const char *tag, const char *fmt, ...) {
    static const char *colors[] = {
        "",             // NONE
        "\033[31m",     // ERROR — red
        "\033[33m",     // WARN  — yellow
        "\033[32m",     // INFO  — green
        "\033[36m",     // DEBUG — cyan
    };
    uint32_t ms = volt_tick_ms();
    printf("%s%02lu:%02lu:%02lu.%03lu [%s] %s: ",
           colors[level],
           (ms/3600000)%24, (ms/60000)%60, (ms/1000)%60, ms%1000,
           level_str[level], tag);
    va_list args;
    va_start(args, fmt);
    vprintf(fmt, args);
    va_end(args);
    printf("\033[0m\n");
}
```

---

## 7. Testing Strategy

### 7.1 Fake HAL for Host Testing

```c
// test/fakes/fake_gpio.h
#include "fff.h"
DEFINE_FFF_GLOBALS;

FAKE_VALUE_FUNC(volt_err_t, gpio_set_mode, uint8_t, gpio_mode_t);
FAKE_VALUE_FUNC(volt_err_t, gpio_write, uint8_t, gpio_level_t);
FAKE_VALUE_FUNC(gpio_level_t, gpio_read, uint8_t);
FAKE_VALUE_FUNC(volt_err_t, gpio_toggle, uint8_t);

// In test:
TEST(blink_toggles_led) {
    RESET_FAKES();
    blink_task_run_once();
    ASSERT_EQ(1, gpio_toggle_fake.call_count);
    ASSERT_EQ(LED_PIN, gpio_toggle_fake.arg0_val);
}
```

### 7.2 Build Configuration

```cmake
# CMakeLists.txt for host tests
if(BUILD_TESTING)
    # Compile against fake HAL, not real hardware
    add_executable(test_runner
        test/test_main.c
        test/test_blink.c
        test/fakes/fake_gpio.c
        src/core/scheduler.c    # real scheduler code
        src/core/task.c         # real task code
    )
    target_include_directories(test_runner PRIVATE
        test/fakes    # fake headers override real HAL
        src           # framework source
    )
endif()
```

---

## 8. Build System Design

### 8.1 Project File (volt.toml)

```toml
[project]
name = "weather-station"
version = "0.1.0"

[chip]
target = "esp32"
flash_size = "4MB"
cpu_freq = 240

[features]
wifi = true
ble = false
mqtt = true
ota = true

[pins]
led = 2
i2c_sda = 21
i2c_scl = 22
```

### 8.2 CLI Tool Flow

```
volt build
  ├── Parse volt.toml
  ├── Generate sdkconfig from features
  ├── Set IDF_TARGET=esp32
  ├── Run idf.py build (under the hood)
  ├── Report flash/RAM usage
  └── Output: build/firmware.bin

volt flash
  ├── Detect serial port
  ├── Run esptool.py (under the hood)
  └── Report success

volt monitor
  ├── Run idf.py monitor (under the hood)
  ├── Add color formatting
  ├── Parse structured logs
  └── Show clean terminal UI
```

---

## Sources

- Protothreads: https://dunkels.com/adam/pt/
- Simon Tatham's Coroutines: https://www.chiark.greenend.org.uk/~sgtatham/coroutines.html
- s_task: https://github.com/xhawk18/s_task
- Barr Group C Standard: https://barrgroup.com/embedded-systems/books/embedded-c-coding-standard
- ESP-IDF HAL Architecture: https://docs.espressif.com/projects/esp-idf/en/stable/esp32/api-guides/hardware-abstraction.html
- Zephyr Device Model: https://docs.zephyrproject.org/latest/kernel/drivers/index.html
- embedded-hal (Rust): https://github.com/rust-embedded/embedded-hal
- QP/C Active Objects: https://www.state-machine.com/qpc
- fff (Fake Function Framework): https://github.com/meekrosoft/fff
- defmt: https://github.com/knurling-rs/defmt
- TRICE logging: https://interrupt.memfault.com/blog/trice
- Measuring Stack Usage: https://interrupt.memfault.com/blog/measuring-stack-usage
- Embedded C Mocking: https://interrupt.memfault.com/blog/unit-test-mocking
