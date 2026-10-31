#include "volt/spi_devices.h"
/* MFRC522 RFID 13.56MHz Reader/Writer (SPI, CS active low) */

#include "volt/spi.h"
#include "volt/log.h"
#include "volt/task.h"

#define MFRC522_COMMAND_REG     0x01
#define MFRC522_COMIRQ_REG      0x04
#define MFRC522_ERROR_REG       0x06
#define MFRC522_FIFO_DATA_REG   0x09
#define MFRC522_FIFO_LEVEL_REG  0x0A
#define MFRC522_BIT_FRAMING_REG 0x0D
#define MFRC522_MODE_REG        0x11
#define MFRC522_TX_CONTROL_REG  0x14
#define MFRC522_TX_ASK_REG      0x15
#define MFRC522_TMODE_REG       0x2A
#define MFRC522_TPRESCALER_REG  0x2B
#define MFRC522_TRELOAD_H       0x2C
#define MFRC522_TRELOAD_L       0x2D
#define MFRC522_VERSION_REG     0x37

static uint8_t mfrc522_read_reg(mfrc522_t *dev, uint8_t reg)
{
    uint8_t tx[2] = { ((reg << 1) & 0x7E) | 0x80, 0x00 };
    uint8_t rx[2] = {0};
    volt_spi_cs_select(dev->cs_pin);
    volt_spi_transfer(dev->bus_id, tx, rx, 2);
    volt_spi_cs_deselect(dev->cs_pin);
    return rx[1];
}

static void mfrc522_write_reg(mfrc522_t *dev, uint8_t reg, uint8_t val)
{
    uint8_t tx[2] = { (reg << 1) & 0x7E, val };
    volt_spi_cs_select(dev->cs_pin);
    volt_spi_write(dev->bus_id, tx, 2);
    volt_spi_cs_deselect(dev->cs_pin);
}

/* Send tx_len bytes to the card and read the reply into rx.
 * last_bits: number of valid bits in the last tx byte (0 = all 8).
 * Returns the number of reply bytes, or -1 on timeout or error. */
static int mfrc522_transceive(mfrc522_t *dev, const uint8_t *tx, uint8_t tx_len,
                              uint8_t *rx, uint8_t rx_max, uint8_t last_bits)
{
    mfrc522_write_reg(dev, MFRC522_COMMAND_REG, 0x00);      // idle
    mfrc522_write_reg(dev, MFRC522_COMIRQ_REG, 0x7F);       // clear IRQ flags
    mfrc522_write_reg(dev, MFRC522_FIFO_LEVEL_REG, 0x80);   // flush FIFO
    for (uint8_t i = 0; i < tx_len; i++) {
        mfrc522_write_reg(dev, MFRC522_FIFO_DATA_REG, tx[i]);
    }
    mfrc522_write_reg(dev, MFRC522_BIT_FRAMING_REG, last_bits & 0x07);
    mfrc522_write_reg(dev, MFRC522_COMMAND_REG, 0x0C);      // transceive
    mfrc522_write_reg(dev, MFRC522_BIT_FRAMING_REG, 0x80 | (last_bits & 0x07)); // start send

    int done = 0;
    for (int t = 0; t < 30; t++) {
        uint8_t irq = mfrc522_read_reg(dev, MFRC522_COMIRQ_REG);
        if (irq & 0x30) { done = 1; break; }   // RxIRq or IdleIRq
        if (irq & 0x01) return -1;             // timer expired: no card answered
        volt_delay_ms(1);
    }
    if (!done) return -1;

    uint8_t err = mfrc522_read_reg(dev, MFRC522_ERROR_REG);
    if (err & 0x1B) return -1;                 // buffer overflow, collision, parity, protocol

    int n = mfrc522_read_reg(dev, MFRC522_FIFO_LEVEL_REG) & 0x7F;
    if (n > rx_max) n = rx_max;
    for (int i = 0; i < n; i++) {
        rx[i] = mfrc522_read_reg(dev, MFRC522_FIFO_DATA_REG);
    }
    return n;
}

volt_error_t mfrc522_init(mfrc522_t *dev, uint8_t bus_id, uint8_t cs_pin)
{
    dev->bus_id = bus_id;
    dev->cs_pin = cs_pin;
    dev->uid_len = 0;
    volt_spi_cs_deselect(cs_pin);

    // Soft reset
    mfrc522_write_reg(dev, MFRC522_COMMAND_REG, 0x0F);
    volt_delay_ms(50);

    // Timer: auto start, prescaler for 25ms timeout
    mfrc522_write_reg(dev, MFRC522_TMODE_REG, 0x80);
    mfrc522_write_reg(dev, MFRC522_TPRESCALER_REG, 0xA9);
    mfrc522_write_reg(dev, MFRC522_TRELOAD_H, 0x03);
    mfrc522_write_reg(dev, MFRC522_TRELOAD_L, 0xE8);

    mfrc522_write_reg(dev, MFRC522_TX_ASK_REG, 0x40);
    mfrc522_write_reg(dev, MFRC522_MODE_REG, 0x3D);

    // Turn on antenna
    uint8_t val = mfrc522_read_reg(dev, MFRC522_TX_CONTROL_REG);
    mfrc522_write_reg(dev, MFRC522_TX_CONTROL_REG, val | 0x03);

    uint8_t version = mfrc522_read_reg(dev, MFRC522_VERSION_REG);
    log_info("mfrc522", "RFID reader v%d.0 on bus %d cs=%d",
             (version == 0x92) ? 2 : 1, bus_id, cs_pin);
    return VOLT_OK;
}

int mfrc522_is_card_present(mfrc522_t *dev)
{
    // WUPA (0x52, 7 bits) wakes cards in any state, so a card that stays on
    // the reader keeps being detected.
    uint8_t cmd = 0x52;
    uint8_t atqa[2] = {0};
    return (mfrc522_transceive(dev, &cmd, 1, atqa, 2, 7) == 2) ? 1 : 0;
}

int mfrc522_read_uid(mfrc522_t *dev)
{
    dev->uid_len = 0;
    if (!mfrc522_is_card_present(dev)) return 0;

    // Anti-collision, cascade level 1: reply is 4 UID bytes + BCC check byte
    uint8_t cmd[2] = { 0x93, 0x20 };
    uint8_t rx[5] = {0};
    if (mfrc522_transceive(dev, cmd, 2, rx, 5, 0) != 5) return 0;
    if ((rx[0] ^ rx[1] ^ rx[2] ^ rx[3]) != rx[4]) return 0;   // BCC mismatch
    if (rx[0] == 0x88) return 0;   // 7/10-byte UID (cascade tag): not supported

    for (int i = 0; i < 4; i++) dev->uid[i] = rx[i];
    dev->uid_len = 4;
    return 4;
}

int mfrc522_uid_value(mfrc522_t *dev)
{
    // The 4 UID bytes of the last read_uid() as one 32-bit number (0 if none).
    if (dev->uid_len != 4) return 0;
    uint32_t v = ((uint32_t)dev->uid[0] << 24) | ((uint32_t)dev->uid[1] << 16) |
                 ((uint32_t)dev->uid[2] << 8)  |  (uint32_t)dev->uid[3];
    return (int)v;
}
