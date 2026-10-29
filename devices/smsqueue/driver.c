/* SmsQueue — outgoing-SMS queue fed by MQTT (ESP32)
 *
 * Payload on the subscribed topic: "<id>|<number>|<text>"
 * The MQTT task parses and validates each message into a FreeRTOS queue;
 * the Volt program takes them out one at a time with next().
 */

#include "volt/sensor.h"
#include "volt/mqtt.h"
#include "volt/pin.h"
#include "volt/log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include <string.h>

#define SQ_DEPTH    8
#define SQ_ID_MAX   32
#define SQ_NUM_MAX  16
#define SQ_TEXT_MAX 160
#define SQ_ERR_MAX  24
#define SQ_SEEN     16

typedef struct {
    char id[SQ_ID_MAX + 1];
    char number[SQ_NUM_MAX + 1];
    char text[SQ_TEXT_MAX + 1];
    char error[SQ_ERR_MAX + 1];
    bool valid;
} sq_msg_t;

static QueueHandle_t sq_queue;
static sq_msg_t sq_cur;
static volatile int32_t sq_dropped;
static char sq_seen[SQ_SEEN][SQ_ID_MAX + 1];
static int sq_seen_next;

static bool sq_id_ok(const char *s, int n)
{
    if (n < 1 || n > SQ_ID_MAX) return false;
    for (int i = 0; i < n; i++) {
        char c = s[i];
        bool ok = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
                  (c >= '0' && c <= '9') || c == '_' || c == '-';
        if (!ok) return false;
    }
    return true;
}

static bool sq_number_ok(const char *s, int n)
{
    int i = 0;
    if (n > 0 && s[0] == '+') i = 1;
    int digits = n - i;
    if (digits < 5 || digits > 15) return false;
    for (; i < n; i++) {
        if (s[i] < '0' || s[i] > '9') return false;
    }
    return true;
}

static void sq_reject(sq_msg_t *m, const char *why)
{
    m->valid = false;
    strncpy(m->error, why, SQ_ERR_MAX);
    m->error[SQ_ERR_MAX] = '\0';
}

// Runs in the MQTT client task: parse, validate, enqueue. Never blocks.
static void sq_on_message(const char *topic, const char *data, int len)
{
    (void)topic;
    sq_msg_t m;
    memset(&m, 0, sizeof(m));

    const char *bar1 = memchr(data, '|', len);
    int id_len = bar1 ? (int)(bar1 - data) : len;
    if (!sq_id_ok(data, id_len)) {
        // No usable id: nothing to acknowledge, so drop and count it
        sq_dropped++;
        log_error("smsqueue", "dropped message without a valid id");
        return;
    }
    memcpy(m.id, data, id_len);
    m.valid = true;

    const char *end = data + len;
    const char *num = bar1 ? bar1 + 1 : NULL;
    const char *bar2 = num ? memchr(num, '|', end - num) : NULL;
    if (!bar2) {
        sq_reject(&m, "bad format");
    } else {
        int num_len = (int)(bar2 - num);
        const char *txt = bar2 + 1;
        int txt_len = (int)(end - txt);
        if (!sq_number_ok(num, num_len)) {
            sq_reject(&m, "bad number");
        } else if (txt_len < 1) {
            sq_reject(&m, "empty text");
        } else if (txt_len > SQ_TEXT_MAX) {
            sq_reject(&m, "text over 160 chars");
        } else {
            memcpy(m.number, num, num_len);
            // Printable ASCII only: Ctrl-Z/ESC would end the SIM800L prompt early
            for (int i = 0; i < txt_len; i++) {
                char c = txt[i];
                m.text[i] = (c >= 0x20 && c <= 0x7E) ? c : '?';
            }
        }
    }

    if (xQueueSend(sq_queue, &m, 0) != pdTRUE) {
        sq_dropped++;
        log_error("smsqueue", "queue full, dropped %s", m.id);
    }
}

volt_error_t smsqueue_init(smsqueue_t *dev, uint8_t led)
{
    dev->led_pin = led;
    pin_set_output(led);
    pin_write(led, 0);
    sq_queue = xQueueCreate(SQ_DEPTH, sizeof(sq_msg_t));
    if (sq_queue == NULL) {
        log_error("smsqueue", "out of memory for queue");
        return VOLT_ERR_INTERNAL;
    }
    return VOLT_OK;
}

bool smsqueue_subscribe(smsqueue_t *dev, const char *topic)
{
    (void)dev;
    return mqtt_on_receive(topic, sq_on_message) == VOLT_OK;
}

bool smsqueue_next(smsqueue_t *dev)
{
    (void)dev;
    if (sq_queue == NULL) return false;
    return xQueueReceive(sq_queue, &sq_cur, 0) == pdTRUE;
}

const char *smsqueue_id(smsqueue_t *dev)     { (void)dev; return sq_cur.id; }
const char *smsqueue_number(smsqueue_t *dev) { (void)dev; return sq_cur.number; }
const char *smsqueue_text(smsqueue_t *dev)   { (void)dev; return sq_cur.text; }
const char *smsqueue_error(smsqueue_t *dev)  { (void)dev; return sq_cur.error; }
bool smsqueue_is_valid(smsqueue_t *dev)         { (void)dev; return sq_cur.valid; }

bool smsqueue_is_duplicate(smsqueue_t *dev)
{
    (void)dev;
    for (int i = 0; i < SQ_SEEN; i++) {
        if (sq_seen[i][0] != '\0' && strcmp(sq_seen[i], sq_cur.id) == 0) return true;
    }
    return false;
}

void smsqueue_mark_sent(smsqueue_t *dev)
{
    (void)dev;
    strcpy(sq_seen[sq_seen_next], sq_cur.id);
    sq_seen_next = (sq_seen_next + 1) % SQ_SEEN;
}

int32_t smsqueue_pending(smsqueue_t *dev)
{
    (void)dev;
    return sq_queue ? (int32_t)uxQueueMessagesWaiting(sq_queue) : 0;
}

int32_t smsqueue_dropped(smsqueue_t *dev) { (void)dev; return sq_dropped; }

void smsqueue_led(smsqueue_t *dev, int32_t on)
{
    pin_write(dev->led_pin, on ? 1 : 0);
}
