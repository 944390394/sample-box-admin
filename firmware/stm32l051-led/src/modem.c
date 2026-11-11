#include "board.h"
#include "radio.h"
#include "clock.h"
#include "gpio.h"
#include "modem.h"
#include "store.h"
#include "uart.h"

static void copy_text(char *dst, const char *src)
{
    unsigned index = 0;
    while (src[index] != '\0' && index + 1u < MODEM_LINE) {
        dst[index] = src[index];
        index++;
    }
    dst[index] = '\0';
}

static void enqueue(modem_t *modem, const char *text)
{
    if (modem->count >= MODEM_SLOTS) {
        modem->dropped++;
        return;
    }
    copy_text(modem->lines[modem->head], text);
    modem->head = (uint8_t)((modem->head + 1u) % MODEM_SLOTS);
    modem->count++;
}

void modem_init(modem_t *modem)
{
    modem->head = 0;
    modem->tail = 0;
    modem->count = 0;
    modem->has_boot = 0;
    modem->boot_line[0] = '\0';
    modem->dropped = 0;
    gpio_set_input(BOARD_PORT_B, BOARD_PIN_DTR, GPIO_PULL_NONE);
    gpio_set_input(BOARD_PORT_B, BOARD_PIN_RST, GPIO_PULL_NONE);
    gpio_set_input(BOARD_PORT_B, BOARD_PIN_RDY, GPIO_PULL_NONE);
    uart_bind(BOARD_USART2, BOARD_PORT_A, BOARD_PIN_USART2_TX, BOARD_PORT_A, BOARD_PIN_USART2_RX);
}

/* 收到过模块的 net= 行就以它为准；老模板没有这行，回退到 RDY 引脚。 */
int modem_is_ready(void)
{
    if (radio_sleeping()) return 0;
    if (clock_link_seen()) {
        return clock_link_online();
    }
    return gpio_read(BOARD_PORT_B, BOARD_PIN_RDY);
}

void modem_flush(modem_t *modem)
{
    store_poll(modem_is_ready());
    static uint32_t retry_at;
    if ((int32_t)(clock_ms()-retry_at)<0 && retry_at-clock_ms()<=1000u) return;
    while (modem->count > 0) {
        if (!store_save(modem->lines[modem->tail])) { retry_at=clock_ms()+1000u; break; }
        modem->tail = (uint8_t)((modem->tail + 1u) % MODEM_SLOTS);
        modem->count--;
    }
}

void modem_submit(modem_t *modem, const char *text)
{
    /* Without an initialized flash, keep legacy live telemetry available. Keep
       lid events queued for durability instead of silently treating TX as ACK. */
    if (!store_available() && !store_durable_event(text) && modem_is_ready()) {
        store_write_failures++;
        uart_write_text(BOARD_USART2,text);
        return;
    }
    if (modem->count != 0u || !store_save(text)) {
        enqueue(modem, text);
    }
    modem_flush(modem);
}

void modem_submit_boot(modem_t *modem, const char *text)
{
    modem_submit(modem, text);
}
