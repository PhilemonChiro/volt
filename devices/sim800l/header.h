#pragma once
#include <stdint.h>
#include <stdbool.h>
#include "volt/error.h"

// SIM800L — GSM/GPRS modem (UART)
typedef struct { uint8_t uart_id; } sim800l_t;
volt_error_t sim800l_init(sim800l_t *dev, uint8_t uart_id);
bool sim800l_ready(sim800l_t *dev);
bool sim800l_registered(sim800l_t *dev);
int32_t sim800l_signal(sim800l_t *dev);
bool sim800l_send_sms(sim800l_t *dev, const char *number, const char *text);
