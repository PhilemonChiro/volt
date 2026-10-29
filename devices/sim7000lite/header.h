#include <stdint.h>
#include <stdbool.h>
#include "volt/error.h"

typedef struct {
    uint8_t uart_id;
    int16_t pwrkey;            /* -1 if not wired */
    bool pwr_active_high;
    uint32_t last_reg_ms;      /* last time it was seen registered */
    char apn[40];
    char from[24];
    char text[161];
} sim7000lite_t;

volt_error_t sim7000lite_init(sim7000lite_t *dev, uint8_t uart_id);
bool sim7000lite_ready(sim7000lite_t *dev);
bool sim7000lite_registered(sim7000lite_t *dev);
int32_t sim7000lite_signal(sim7000lite_t *dev);
bool sim7000lite_send_sms(sim7000lite_t *dev, const char *number, const char *text);
bool sim7000lite_next_sms(sim7000lite_t *dev);
const char *sim7000lite_sms_from(sim7000lite_t *dev);
const char *sim7000lite_sms_text(sim7000lite_t *dev);
int32_t sim7000lite_http_post(sim7000lite_t *dev, const char *url, const char *body);
const char *sim7000lite_ussd(sim7000lite_t *dev, const char *code);
void sim7000lite_set_apn(sim7000lite_t *dev, const char *apn);
void sim7000lite_set_pwrkey(sim7000lite_t *dev, int32_t pin, bool active_high);
bool sim7000lite_maintain(sim7000lite_t *dev);
