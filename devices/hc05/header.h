#pragma once
#include <stdint.h>
#include <stdbool.h>
#include "volt/error.h"

// hc05 (installed library — generated header)
typedef struct { uint8_t uart_id; } hc05_t;
volt_error_t hc05_init(hc05_t *dev, uint8_t uart_id);
volt_error_t hc05_send_data(hc05_t *dev, int data);
int hc05_receive_data(hc05_t *dev, char * buffer, uint16_t max_len);
volt_error_t hc05_send_at_command(hc05_t *dev, const char * command);
int32_t hc05_read_at_response(hc05_t *dev, char * response, uint16_t max_len);
volt_error_t hc05_set_baud_rate(hc05_t *dev, int baud_rate);
volt_error_t hc05_set_name(hc05_t *dev, const char * name);
volt_error_t hc05_set_password(hc05_t *dev, const char * password);
volt_error_t hc05_send(hc05_t *dev, const char *text);
volt_error_t hc05_send_line(hc05_t *dev, const char *text);
bool hc05_available(hc05_t *dev);
const char *hc05_read_line(hc05_t *dev);
