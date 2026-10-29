// smsqueue (installed library — generated header)
typedef struct { uint8_t led_pin; } smsqueue_t;
volt_error_t smsqueue_init(smsqueue_t *dev, uint8_t led);
bool smsqueue_subscribe(smsqueue_t *dev, const char *topic);
bool smsqueue_next(smsqueue_t *dev);
const char *smsqueue_id(smsqueue_t *dev);
const char *smsqueue_number(smsqueue_t *dev);
const char *smsqueue_text(smsqueue_t *dev);
bool smsqueue_is_valid(smsqueue_t *dev);
const char *smsqueue_error(smsqueue_t *dev);
bool smsqueue_is_duplicate(smsqueue_t *dev);
void smsqueue_mark_sent(smsqueue_t *dev);
int32_t smsqueue_pending(smsqueue_t *dev);
int32_t smsqueue_dropped(smsqueue_t *dev);
void smsqueue_led(smsqueue_t *dev, int32_t on);
