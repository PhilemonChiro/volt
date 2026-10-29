/* SIMCom SIM7000 modem, lean driver: SMS, HTTP POST over GPRS, USSD and
 * self-recovery. Application logic (whitelists, command parsing) belongs
 * in the program, not here. */

#include "volt/uart.h"
#include "volt/pin.h"
#include "volt/task.h"
#include "volt/log.h"
#include <string.h>
#include <stdio.h>
#include <stdlib.h>
#ifdef ESP_PLATFORM
#include "esp_task_wdt.h"
#endif

#define RESP_MAX 256
#define UNREG_RECOVER_MS (180u * 1000u)   /* off-network this long -> recover */

static const uint32_t backoff_ms[] = {2000, 5000};

/* ---- low level ------------------------------------------------------------ */

/* Long waits must not starve the task watchdog. */
static void feed(void)
{
#ifdef ESP_PLATFORM
    if (esp_task_wdt_status(NULL) == ESP_OK) esp_task_wdt_reset();
#endif
}

static void nap(uint32_t ms)
{
    while (ms > 0) {
        uint32_t step = ms > 200 ? 200 : ms;
        feed();
        volt_delay_ms(step);
        ms -= step;
    }
}

static void drain(sim7000lite_t *dev)
{
    while (volt_uart_read_byte(dev->uart_id) >= 0) {}
}

/* Collect bytes until `expect` (or ERROR) appears or the timeout passes. */
static bool wait_for(sim7000lite_t *dev, const char *expect, uint32_t timeout_ms, char *resp, int size)
{
    int len = 0;
    resp[0] = '\0';
    uint32_t t0 = volt_tick_ms();
    while (volt_tick_ms() - t0 < timeout_ms) {
        int c = volt_uart_read_byte(dev->uart_id);
        if (c < 0) { feed(); volt_delay_ms(5); continue; }
        if (c == 0 || c >= 0x80) continue;   /* transmit-burst noise */
        if (len < size - 1) { resp[len++] = (char)c; resp[len] = '\0'; }
        if (strstr(resp, expect)) return true;
        if (strstr(resp, "ERROR")) return false;
    }
    return false;
}

static bool at(sim7000lite_t *dev, const char *cmd, const char *expect, uint32_t timeout_ms, char *resp)
{
    drain(dev);
    volt_uart_print(dev->uart_id, cmd);
    volt_uart_print(dev->uart_id, "\r");
    return wait_for(dev, expect, timeout_ms, resp, RESP_MAX);
}

static bool alive(sim7000lite_t *dev)
{
    char resp[RESP_MAX];
    for (int i = 0; i < 3; i++)
        if (at(dev, "AT", "OK", 500, resp)) return true;
    return false;
}

static bool wait_boot(sim7000lite_t *dev, uint32_t timeout_ms)
{
    uint32_t t0 = volt_tick_ms();
    while (volt_tick_ms() - t0 < timeout_ms) {
        if (alive(dev)) return true;
        nap(500);
    }
    return false;
}

/* Settings applied after every (re)start. */
static void configure(sim7000lite_t *dev)
{
    char resp[RESP_MAX];
    at(dev, "ATE0", "OK", 1000, resp);
    at(dev, "AT+CMEE=2", "OK", 1000, resp);
    at(dev, "AT+CNMP=13", "OK", 3000, resp);                      /* GSM only */
    at(dev, "AT+CMGF=1", "OK", 1000, resp);                       /* SMS text mode */
    at(dev, "AT+CSCS=\"GSM\"", "OK", 1000, resp);
    at(dev, "AT+CPMS=\"SM\",\"SM\",\"SM\"", "OK", 2000, resp);    /* store incoming on SIM */
    at(dev, "AT+CNMI=1,1,0,0,0", "OK", 1000, resp);               /* no unsolicited text dumps */
    dev->last_reg_ms = volt_tick_ms();
}

/* ---- lifecycle -------------------------------------------------------------- */

volt_error_t sim7000lite_init(sim7000lite_t *dev, uint8_t uart_id)
{
    memset(dev, 0, sizeof(*dev));
    dev->uart_id = uart_id;
    dev->pwrkey = -1;
    if (!wait_boot(dev, 5000)) {
        log_error("sim7000", "no response on uart %d (check supply, GND, TX/RX)", uart_id);
        return VOLT_ERR_INTERNAL;
    }
    configure(dev);
    log_info("sim7000", "modem ready on uart %d", uart_id);
    return VOLT_OK;
}

void sim7000lite_set_apn(sim7000lite_t *dev, const char *apn)
{
    strncpy(dev->apn, apn, sizeof(dev->apn) - 1);
    dev->apn[sizeof(dev->apn) - 1] = '\0';
}

void sim7000lite_set_pwrkey(sim7000lite_t *dev, int32_t pin, bool active_high)
{
    dev->pwrkey = (int16_t)pin;
    dev->pwr_active_high = active_high;
    pin_set_input((uint8_t)pin);   /* released: the board's pull sets the idle level */
}

static void press(sim7000lite_t *dev, uint32_t ms)
{
    uint8_t pin = (uint8_t)dev->pwrkey;
    pin_set_output(pin);
    pin_write(pin, dev->pwr_active_high ? 1 : 0);
    nap(ms);
    pin_set_input(pin);
}

/* Soft reset if the modem answers, otherwise (or if that fails) power-cycle. */
static bool recover(sim7000lite_t *dev)
{
    char resp[RESP_MAX];
    log_info("sim7000", "recovering modem");
    if (alive(dev) && at(dev, "AT+CFUN=1,1", "OK", 5000, resp)) {
        nap(3000);
        if (wait_boot(dev, 30000)) { configure(dev); return true; }
    }
    if (dev->pwrkey < 0) {
        log_error("sim7000", "recovery failed (no PWRKEY pin set)");
        return false;
    }
    if (alive(dev)) {                 /* on: press to switch off */
        press(dev, 1500);
        nap(5000);
    }
    press(dev, 1200);                 /* off: press to switch on */
    if (!wait_boot(dev, 30000)) {
        log_error("sim7000", "no answer after power cycle");
        return false;
    }
    configure(dev);
    return true;
}

/* ---- status ----------------------------------------------------------------- */

bool sim7000lite_ready(sim7000lite_t *dev)
{
    return alive(dev);
}

bool sim7000lite_registered(sim7000lite_t *dev)
{
    char resp[RESP_MAX];
    if (!at(dev, "AT+CREG?", "OK", 1000, resp)) return false;
    const char *p = strstr(resp, "+CREG:");
    if (!p || !(p = strchr(p, ','))) return false;
    int stat = atoi(p + 1);
    if (stat != 1 && stat != 5) return false;
    dev->last_reg_ms = volt_tick_ms();
    return true;
}

int32_t sim7000lite_signal(sim7000lite_t *dev)
{
    char resp[RESP_MAX];
    int rssi = 99;
    if (!at(dev, "AT+CSQ", "OK", 1000, resp)) return 99;
    const char *p = strstr(resp, "+CSQ:");
    if (p) sscanf(p, "+CSQ: %d", &rssi);
    return rssi;
}

bool sim7000lite_maintain(sim7000lite_t *dev)
{
    if (sim7000lite_registered(dev)) return true;
    if (!alive(dev)) {
        log_error("sim7000", "modem not answering");
        recover(dev);
    } else if (volt_tick_ms() - dev->last_reg_ms > UNREG_RECOVER_MS) {
        log_error("sim7000", "off network for %u s", (unsigned)(UNREG_RECOVER_MS / 1000));
        recover(dev);
        dev->last_reg_ms = volt_tick_ms();   /* give it another window */
    }
    return sim7000lite_registered(dev);
}

/* ---- SMS ---------------------------------------------------------------------- */

/* 1 sent, 0 refused before sending (safe to retry), -1 unknown (never retried). */
static int sms_once(sim7000lite_t *dev, const char *number, const char *text)
{
    char resp[RESP_MAX];
    char cmd[48];
    snprintf(cmd, sizeof(cmd), "AT+CMGS=\"%s\"", number);
    if (!at(dev, cmd, ">", 5000, resp)) {
        volt_uart_print(dev->uart_id, "\x1b");   /* leave prompt mode if half-entered */
        return 0;
    }
    volt_uart_print(dev->uart_id, text);
    volt_uart_print(dev->uart_id, "\x1a");      /* Ctrl-Z sends */
    if (wait_for(dev, "OK", 30000, resp, RESP_MAX) && strstr(resp, "+CMGS:")) return 1;
    if (strstr(resp, "+CMS ERROR")) return 0;
    return -1;
}

bool sim7000lite_send_sms(sim7000lite_t *dev, const char *number, const char *text)
{
    for (int attempt = 0; attempt < 3; attempt++) {
        if (!alive(dev) && !recover(dev)) return false;
        int r = sms_once(dev, number, text);
        if (r == 1) { log_info("sim7000", "SMS to %s sent", number); return true; }
        if (r < 0) { log_error("sim7000", "SMS to %s: outcome unknown", number); return false; }
        if (attempt < 2) nap(backoff_ms[attempt]);
    }
    log_error("sim7000", "SMS to %s refused", number);
    return false;
}

/* Copy the quoted field number `n` (0-based) of `line` into out. */
static void quoted_field(const char *line, int n, char *out, int size)
{
    out[0] = '\0';
    const char *q = line;
    for (int i = 0; i < 2 * n + 1; i++) {
        q = strchr(q, '"');
        if (!q) return;
        q++;
    }
    const char *e = strchr(q, '"');
    int len = e ? (int)(e - q) : 0;
    if (len > size - 1) len = size - 1;
    memcpy(out, q, len);
    out[len] = '\0';
}

bool sim7000lite_next_sms(sim7000lite_t *dev)
{
    static char buf[512];
    char resp[RESP_MAX];
    char cmd[24];
    dev->from[0] = dev->text[0] = '\0';

    /* First stored message index (1 = leave status unchanged). */
    drain(dev);
    volt_uart_print(dev->uart_id, "AT+CMGL=\"ALL\",1\r");
    wait_for(dev, "OK\r\n", 3000, buf, sizeof(buf));
    const char *p = strstr(buf, "+CMGL:");
    if (!p) return false;
    int idx = atoi(p + 6);

    /* +CMGR: "<stat>","<from>","","<time>"\r\n<text>\r\n\r\nOK */
    snprintf(cmd, sizeof(cmd), "AT+CMGR=%d", idx);
    drain(dev);
    volt_uart_print(dev->uart_id, cmd);
    volt_uart_print(dev->uart_id, "\r");
    if (!wait_for(dev, "OK\r\n", 3000, buf, sizeof(buf)) || !(p = strstr(buf, "+CMGR:"))) return false;

    quoted_field(p, 1, dev->from, sizeof(dev->from));
    const char *t = strstr(p, "\r\n");
    if (t) {
        t += 2;
        const char *te = strstr(t, "\r\nOK");
        int n = te ? (int)(te - t) : (int)strlen(t);
        while (n > 0 && (t[n - 1] == '\r' || t[n - 1] == '\n' || t[n - 1] == ' ')) n--;
        if (n > (int)sizeof(dev->text) - 1) n = sizeof(dev->text) - 1;
        memcpy(dev->text, t, n);
        dev->text[n] = '\0';
    }

    snprintf(cmd, sizeof(cmd), "AT+CMGD=%d", idx);
    at(dev, cmd, "OK", 5000, resp);   /* free the slot */
    log_info("sim7000", "SMS from %s: %s", dev->from, dev->text);
    return true;
}

const char *sim7000lite_sms_from(sim7000lite_t *dev) { return dev->from; }
const char *sim7000lite_sms_text(sim7000lite_t *dev) { return dev->text; }

/* ---- HTTP over GPRS ------------------------------------------------------------- */

static int32_t http_once(sim7000lite_t *dev, const char *url, const char *body)
{
    char resp[RESP_MAX];
    char cmd[200];

    /* GPRS bearer, kept open between posts */
    if (!at(dev, "AT+SAPBR=2,1", "OK", 3000, resp) || !strstr(resp, "+SAPBR: 1,1")) {
        at(dev, "AT+SAPBR=3,1,\"CONTYPE\",\"GPRS\"", "OK", 2000, resp);
        snprintf(cmd, sizeof(cmd), "AT+SAPBR=3,1,\"APN\",\"%s\"", dev->apn);
        at(dev, cmd, "OK", 2000, resp);
        if (!at(dev, "AT+SAPBR=1,1", "OK", 30000, resp)) {
            log_error("sim7000", "GPRS bearer failed (APN \"%s\")", dev->apn);
            return -1;
        }
    }

    at(dev, "AT+HTTPTERM", "OK", 2000, resp);   /* clear any previous session */
    if (!at(dev, "AT+HTTPINIT", "OK", 5000, resp)) return -1;
    at(dev, "AT+HTTPPARA=\"CID\",1", "OK", 2000, resp);
    snprintf(cmd, sizeof(cmd), "AT+HTTPPARA=\"URL\",\"%s\"", url);
    at(dev, cmd, "OK", 2000, resp);
    at(dev, "AT+HTTPPARA=\"CONTENT\",\"application/x-www-form-urlencoded\"", "OK", 2000, resp);

    int32_t status = -1;
    snprintf(cmd, sizeof(cmd), "AT+HTTPDATA=%d,10000", (int)strlen(body));
    if (at(dev, cmd, "DOWNLOAD", 5000, resp)) {
        volt_delay_ms(100);   /* data sent while "DOWNLOAD\r\n" is still going out is lost */
        drain(dev);
        volt_uart_print(dev->uart_id, body);
        wait_for(dev, "OK", 3000, resp, RESP_MAX);
        /* +HTTPACTION: <method>,<status>,<length> */
        char tail[64];
        int method = 0, code = -1;
        if (at(dev, "AT+HTTPACTION=1", "+HTTPACTION:", 20000, resp) &&
            wait_for(dev, "\n", 2000, tail, sizeof(tail)) &&
            sscanf(tail, " %d,%d", &method, &code) == 2)
            status = code;
    }
    at(dev, "AT+HTTPTERM", "OK", 2000, resp);
    return status;
}

int32_t sim7000lite_http_post(sim7000lite_t *dev, const char *url, const char *body)
{
    int32_t status = -1;
    for (int attempt = 0; attempt < 3; attempt++) {
        if (!alive(dev) && !recover(dev)) return -1;
        status = http_once(dev, url, body);
        if (status >= 0 && status < 500) break;
        if (attempt < 2) nap(backoff_ms[attempt]);
    }
    log_info("sim7000", "HTTP POST %s -> %d", url, (int)status);
    return status;
}

/* ---- USSD --------------------------------------------------------------------------- */

static int hexval(char c)
{
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    return -1;
}

/* UCS-2 hex ("0042 0061...") -> ASCII in place; non-ASCII becomes '?'. */
static void ucs2_to_ascii(char *s)
{
    int n = (int)strlen(s), j = 0;
    for (int i = 0; i + 3 < n; i += 4) {
        int v = 0;
        for (int k = 0; k < 4; k++) {
            int h = hexval(s[i + k]);
            if (h < 0) return;   /* not hex after all */
            v = v * 16 + h;
        }
        s[j++] = (v >= 32 && v < 127) || v == '\n' ? (char)v : '?';
    }
    s[j] = '\0';
}

const char *sim7000lite_ussd(sim7000lite_t *dev, const char *code)
{
    static char reply[200];
    static char buf[512];
    char cmd[64];
    reply[0] = '\0';
    if (!alive(dev) && !recover(dev)) return reply;

    snprintf(cmd, sizeof(cmd), "AT+CUSD=1,\"%s\",15", code);
    drain(dev);
    volt_uart_print(dev->uart_id, cmd);
    volt_uart_print(dev->uart_id, "\r");
    /* OK, then +CUSD: <m>,"<text>",<dcs> once the network answers; the text
     * may span lines, so read until the closing quote is in. */
    if (!wait_for(dev, "+CUSD:", 20000, buf, sizeof(buf))) {
        log_error("sim7000", "USSD %s: no reply", code);
        return reply;
    }
    for (int i = 0; i < 3; i++) {
        const char *q = strchr(buf, '"');
        q = q ? strchr(q + 1, '"') : NULL;
        if (q && strchr(q, '\n')) break;                   /* both quotes and ,<dcs> in */
        int used = (int)strlen(buf);
        if (!wait_for(dev, q ? "\n" : "\"", 8000, buf + used, (int)sizeof(buf) - used)) break;
    }

    const char *p = strstr(buf, "+CUSD:");
    int m = atoi(p + 6);
    quoted_field(p, 0, reply, sizeof(reply));
    const char *e = strrchr(p, '"');
    int dcs = (e && e[1] == ',') ? atoi(e + 2) : 15;
    if (dcs == 72 || dcs == 17) ucs2_to_ascii(reply);

    if (m == 1) {   /* network left a menu open: close it */
        char resp[RESP_MAX];
        at(dev, "AT+CUSD=2", "OK", 3000, resp);
    }
    log_info("sim7000", "USSD %s -> %s", code, reply);
    return reply;
}
