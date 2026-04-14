# Register this component with ESP-IDF's build system
# SRCS = which .c files to compile (main + all framework source files)
# INCLUDE_DIRS = where to find .h headers
idf_component_register(
    SRCS "main.c"
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
         "../src/sensor_bme280.c"
         "../src/sensor_bh1750.c"
    INCLUDE_DIRS "../include"
)
