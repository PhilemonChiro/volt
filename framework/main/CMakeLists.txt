# Register this component with ESP-IDF's build system
# Core framework sources (always included)
set(CORE_SRCS
    "main.c"
    "../src/error.c"
    "../src/log.c"
    "../src/pin.c"
    "../src/task.c"
    "../src/wifi.c"
    "../src/mqtt.c"
    "../src/storage.c"
    "../src/http.c"
    "../src/system.c"
    "../src/i2c.c"
    "../src/spi.c"
)

# Auto-discover all device drivers from devices/*/driver.c
file(GLOB DEVICE_DRIVERS "../../devices/*/driver.c")

idf_component_register(
    SRCS ${CORE_SRCS} ${DEVICE_DRIVERS}
    INCLUDE_DIRS "../include"
)
