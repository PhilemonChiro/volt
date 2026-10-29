#pragma once
#include <stdint.h>
#include <stdbool.h>
#include "volt/error.h"

// SIM7000 — LTE-M/NB-IoT/GSM modem (UART): SMS + HTTP over GPRS
typedef struct {
    uint8_t uart_id;
    int32_t last_ref;          // reference of the last SMS (-1 none)
    int32_t receipt;           // 1 delivered, 0 pending, -1 failed
    bool alive;
    int16_t pwrkey;            // PWRKEY GPIO, -1 if not wired
    bool pwr_active_high;
    uint32_t last_reg_ms;      // last time it was seen registered
} sim7000_t;
volt_error_t sim7000_init(sim7000_t *dev, uint8_t uart_id);
void sim7000_set_pwrkey(sim7000_t *dev, int32_t pin, bool active_high);
bool sim7000_reset(sim7000_t *dev);
bool sim7000_power_cycle(sim7000_t *dev);
bool sim7000_recover(sim7000_t *dev);
int32_t sim7000_maintain(sim7000_t *dev);
bool sim7000_ready(sim7000_t *dev);
bool sim7000_registered(sim7000_t *dev);
int32_t sim7000_network_status(sim7000_t *dev);
int32_t sim7000_signal(sim7000_t *dev);
int32_t sim7000_signal_dbm(sim7000_t *dev);
const char *sim7000_operator_name(sim7000_t *dev);
int32_t sim7000_voltage(sim7000_t *dev);
int32_t sim7000_network_time(sim7000_t *dev);
bool sim7000_send_sms(sim7000_t *dev, const char *number, const char *text);
int32_t sim7000_check_receipt(sim7000_t *dev);
int32_t sim7000_http_post(sim7000_t *dev, const char *url, const char *body);
const char *sim7000_ussd(sim7000_t *dev, const char *code);
void sim7000_allow_number(sim7000_t *dev, const char *number);
bool sim7000_next_sms(sim7000_t *dev);
const char *sim7000_sms_from(sim7000_t *dev);
const char *sim7000_sms_text(sim7000_t *dev);
bool sim7000_sms_allowed(sim7000_t *dev);
const char *sim7000_sms_command(sim7000_t *dev);
bool sim7000_sms_command_is(sim7000_t *dev, const char *cmd);
int32_t sim7000_sms_arg_int(sim7000_t *dev);
const char *sim7000_sms_arg(sim7000_t *dev);
bool sim7000_sms_arg_is(sim7000_t *dev, const char *word);
void sim7000_load_alert_number(sim7000_t *dev, const char *fallback);
const char *sim7000_alert_number(sim7000_t *dev);
bool sim7000_set_alert_number_from_sms(sim7000_t *dev);
void sim7000_load_whitelist(sim7000_t *dev);
int32_t sim7000_whitelist_add_from_sms(sim7000_t *dev);
int32_t sim7000_whitelist_remove_from_sms(sim7000_t *dev);
const char *sim7000_whitelist_text(sim7000_t *dev);
