cmake_minimum_required(VERSION 3.13)

# Pull in pico SDK (path set by PICO_SDK_PATH env var)
include($ENV{PICO_SDK_PATH}/pico_sdk_init.cmake)

project(volt-rp2040 C CXX ASM)
set(CMAKE_C_STANDARD 11)

pico_sdk_init()

add_executable(volt-rp2040
    main/main.c
    src/pin.c
    src/task.c
    src/log.c
    src/error.c
    src/system.c
    src/storage.c
    src/i2c.c
    src/spi.c
    ../framework/src/spi_w25q.c
    ../framework/src/spi_max31855.c
    ../framework/src/spi_mcp3008.c
    ../framework/src/sensor_bme280.c
    ../framework/src/sensor_aht20.c
    ../framework/src/sensor_sht31.c
    ../framework/src/sensor_mpu6050.c
    ../framework/src/sensor_ina219.c
    ../framework/src/sensor_ds3231.c
    ../framework/src/sensor_bh1750.c
    ../framework/src/sensor_veml7700.c
    ../framework/src/sensor_bmp180.c
    ../framework/src/sensor_ads1115.c
    ../framework/src/sensor_pca9685.c
    ../framework/src/sensor_pcf8574.c
    ../framework/src/sensor_mlx90614.c
    ../framework/src/sensor_mcp4725.c
    ../framework/src/sensor_max30102.c
    ../framework/src/sensor_max30100.c
    ../framework/src/display_hd44780.c
    ../framework/src/sensor_bme680.c
    ../framework/src/sensor_apds9960.c
    ../framework/src/sensor_qmc5883l.c
    ../framework/src/sensor_tca9548a.c
    ../framework/src/sensor_htu21d.c
    ../framework/src/sensor_ms5611.c
    ../framework/src/spi_max7219.c
)

# Include the shared Volt headers
target_include_directories(volt-rp2040 PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}/../framework/include
)

# Link pico SDK libraries
target_link_libraries(volt-rp2040
    pico_stdlib
    hardware_gpio
    hardware_pwm
    hardware_i2c
    hardware_spi
    hardware_timer
    hardware_adc
    hardware_watchdog
    pico_unique_id
)

# Enable USB serial output (not UART — Pico uses USB CDC)
pico_enable_stdio_usb(volt-rp2040 1)
pico_enable_stdio_uart(volt-rp2040 0)

# Generate .uf2 file for drag-and-drop flashing
pico_add_extra_outputs(volt-rp2040)
