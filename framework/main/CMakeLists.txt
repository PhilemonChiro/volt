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
         "../src/spi.c"
         "../src/sensor_bme280.c"
         "../src/sensor_aht20.c"
         "../src/sensor_sht31.c"
         "../src/sensor_mpu6050.c"
         "../src/sensor_ina219.c"
         "../src/sensor_ds3231.c"
         "../src/sensor_bh1750.c"
         "../src/sensor_veml7700.c"
    INCLUDE_DIRS "../include"
)
