#include "volt/i2c.h"
#include "volt/log.h"
#include "driver/i2c.h"

#define I2C_TIMEOUT_MS 1000

volt_error_t volt_i2c_init(uint8_t bus_id, uint8_t sda, uint8_t scl, uint32_t speed)
{
    i2c_config_t conf = {
        .mode = I2C_MODE_MASTER,
        .sda_io_num = sda,
        .scl_io_num = scl,
        .sda_pullup_en = GPIO_PULLUP_ENABLE,
        .scl_pullup_en = GPIO_PULLUP_ENABLE,
        .master.clk_speed = speed ? speed : 400000,
    };

    esp_err_t err = i2c_param_config(bus_id, &conf);
    if (err != ESP_OK) {
        log_error("i2c", "config failed on bus %d (err=%d)", bus_id, err);
        return VOLT_ERR_INTERNAL;
    }

    err = i2c_driver_install(bus_id, I2C_MODE_MASTER, 0, 0, 0);
    if (err != ESP_OK) {
        log_error("i2c", "driver install failed on bus %d (err=%d)", bus_id, err);
        return VOLT_ERR_INTERNAL;
    }

    log_info("i2c", "bus %d initialized (SDA=%d SCL=%d speed=%lu)",
             bus_id, sda, scl, (unsigned long)speed);
    return VOLT_OK;
}

volt_error_t volt_i2c_write(uint8_t bus_id, uint8_t addr, const uint8_t *data, uint8_t len)
{
    i2c_cmd_handle_t cmd = i2c_cmd_link_create();
    i2c_master_start(cmd);
    i2c_master_write_byte(cmd, (addr << 1) | I2C_MASTER_WRITE, true);
    i2c_master_write(cmd, data, len, true);
    i2c_master_stop(cmd);
    esp_err_t err = i2c_master_cmd_begin(bus_id, cmd, I2C_TIMEOUT_MS / portTICK_PERIOD_MS);
    i2c_cmd_link_delete(cmd);
    return err == ESP_OK ? VOLT_OK : VOLT_ERR_INTERNAL;
}

volt_error_t volt_i2c_read(uint8_t bus_id, uint8_t addr, uint8_t *buf, uint8_t len)
{
    i2c_cmd_handle_t cmd = i2c_cmd_link_create();
    i2c_master_start(cmd);
    i2c_master_write_byte(cmd, (addr << 1) | I2C_MASTER_READ, true);
    if (len > 1) {
        i2c_master_read(cmd, buf, len - 1, I2C_MASTER_ACK);
    }
    i2c_master_read_byte(cmd, buf + len - 1, I2C_MASTER_NACK);
    i2c_master_stop(cmd);
    esp_err_t err = i2c_master_cmd_begin(bus_id, cmd, I2C_TIMEOUT_MS / portTICK_PERIOD_MS);
    i2c_cmd_link_delete(cmd);
    return err == ESP_OK ? VOLT_OK : VOLT_ERR_INTERNAL;
}

volt_error_t volt_i2c_write_read(uint8_t bus_id, uint8_t addr,
                            const uint8_t *write_data, uint8_t write_len,
                            uint8_t *read_buf, uint8_t read_len)
{
    i2c_cmd_handle_t cmd = i2c_cmd_link_create();
    // Write phase
    i2c_master_start(cmd);
    i2c_master_write_byte(cmd, (addr << 1) | I2C_MASTER_WRITE, true);
    i2c_master_write(cmd, write_data, write_len, true);
    // Repeated start + read phase
    i2c_master_start(cmd);
    i2c_master_write_byte(cmd, (addr << 1) | I2C_MASTER_READ, true);
    if (read_len > 1) {
        i2c_master_read(cmd, read_buf, read_len - 1, I2C_MASTER_ACK);
    }
    i2c_master_read_byte(cmd, read_buf + read_len - 1, I2C_MASTER_NACK);
    i2c_master_stop(cmd);
    esp_err_t err = i2c_master_cmd_begin(bus_id, cmd, I2C_TIMEOUT_MS / portTICK_PERIOD_MS);
    i2c_cmd_link_delete(cmd);
    return err == ESP_OK ? VOLT_OK : VOLT_ERR_INTERNAL;
}

uint8_t volt_i2c_read_reg(uint8_t bus_id, uint8_t addr, uint8_t reg)
{
    uint8_t val = 0;
    volt_i2c_write_read(bus_id, addr, &reg, 1, &val, 1);
    return val;
}

volt_error_t volt_i2c_write_reg(uint8_t bus_id, uint8_t addr, uint8_t reg, uint8_t value)
{
    uint8_t data[2] = { reg, value };
    return volt_i2c_write(bus_id, addr, data, 2);
}

uint16_t volt_i2c_read_reg16(uint8_t bus_id, uint8_t addr, uint8_t reg)
{
    uint8_t buf[2] = {0};
    volt_i2c_write_read(bus_id, addr, &reg, 1, buf, 2);
    return (buf[0] << 8) | buf[1];
}
