#include "module.h"

#include "board.h"
#include "delay.h"
#include "lpuart.h"
#include "pins.h"

static int powered;
static int asleep_uart;
static int in_session;

static void reset_pulse(void)
{
    pin_write(GPIOB, BOARD_MOD_RST_PIN, 0);
    delay_ms(BOARD_RST_PULSE_MS);
    pin_write(GPIOB, BOARD_MOD_RST_PIN, 1);
}

void module_apply_saved(int on)
{
    in_session = 0;
    asleep_uart = 0;
    pin_write(GPIOB, BOARD_MOD_RST_PIN, 1);
    pin_mode(GPIOB, BOARD_MOD_RST_PIN, 1);
    pin_write(GPIOB, BOARD_MOD_PWR_PIN, on ? 1 : 0);
    pin_mode(GPIOB, BOARD_MOD_PWR_PIN, 1);
    powered = on ? 1 : 0;
    if (on) {
        delay_ms(50);
        reset_pulse();
    }
}

void module_begin(void)
{
    if (in_session) {
        return;
    }
    if (!powered) {
        pin_write(GPIOB, BOARD_MOD_PWR_PIN, 1);
        delay_ms(50);
        reset_pulse();
        powered = 1;
        asleep_uart = 0;
    } else if (asleep_uart) {
        static const uint8_t wake[2] = {0xAAu, 0x55u};
        lpuart_write(wake, 2);
        delay_ms(BOARD_AA55_DELAY_MS);
    }
    in_session = 1;
}

void module_end(int keep_power)
{
    in_session = 0;
    if (!keep_power) {
        pin_write(GPIOB, BOARD_MOD_PWR_PIN, 0);
        powered = 0;
        asleep_uart = 0;
        return;
    }
    asleep_uart = 1;
}

int module_rdy(void)
{
    int high = pin_read(GPIOB, BOARD_MOD_RDY_PIN);
    return BOARD_MOD_RDY_ACTIVE_HIGH ? high : !high;
}
