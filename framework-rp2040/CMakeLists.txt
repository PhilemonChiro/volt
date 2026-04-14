cmake_minimum_required(VERSION 3.13)

# Pull in pico SDK (path set by PICO_SDK_PATH env var)
include($ENV{PICO_SDK_PATH}/pico_sdk_init.cmake)

project(volt-rp2040 C CXX ASM)
set(CMAKE_C_STANDARD 11)

pico_sdk_init()

# Auto-discover all device drivers from devices/*/driver.c
file(GLOB DEVICE_DRIVERS "${CMAKE_CURRENT_SOURCE_DIR}/../devices/*/driver.c")

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
    src/uart.c
    ${DEVICE_DRIVERS}
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
    hardware_uart
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
