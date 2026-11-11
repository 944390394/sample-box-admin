#include "board.h"
#include "charger.h"
#include "gpio.h"

#define CHARGE_DEBOUNCE_MS 50u

void charger_init(charger_t *charger, event_queue_t *queue)
{
    gpio_set_input(BOARD_PORT_B, BOARD_PIN_CHRG, GPIO_PULL_UP);
    gpio_set_input(BOARD_PORT_B, BOARD_PIN_STDBY, GPIO_PULL_UP);
    charger->queue = queue;
    charger->stable = (uint8_t)charger_status();
    charger->pending = charger->stable;
    charger->pending_ms = 0;
    charger->held = 0;
    charger->full_mv = 0;
}

int charger_status(void)
{
    int charging = !gpio_read(BOARD_PORT_B, BOARD_PIN_CHRG);
    int full = !gpio_read(BOARD_PORT_B, BOARD_PIN_STDBY);
    if (charging) {
        return 1;
    }
    if (full) {
        return 2;
    }
    return 0;
}

void charger_on_ms(charger_t *charger)
{
    uint8_t now = (uint8_t)charger_status();
    if (now == charger->pending) {
        if (charger->pending_ms < 255u) {
            charger->pending_ms++;
        }
    } else {
        charger->pending = now;
        charger->pending_ms = 1u;
    }
    if (charger->pending_ms < CHARGE_DEBOUNCE_MS || charger->pending == charger->stable) {
        return;
    }
    if ((charger->pending != 0u) != (charger->stable != 0u)) {
        event_post(charger->queue, EVENT_CHARGE);
    }
    charger->stable = charger->pending;
}

int charger_settled(const charger_t *charger)
{
    return charger->pending == charger->stable && (uint8_t)charger_status() == charger->stable;
}

int charger_view(charger_t *charger, int battery_mv)
{
    uint8_t now = charger->stable;
    if (now == 0u) {
        /* 拔掉了：锁定解除，下次插上重新判断 */
        charger->held = 0;
        charger->full_mv = 0;
        return 0;
    }
    if (now == 2u) {
        if (!charger->held) {
            charger->held = 1;
            charger->full_mv = battery_mv;
        } else if (battery_mv > charger->full_mv) {
            charger->full_mv = battery_mv;
        }
        return 2;
    }
    /* 芯片说在充电：没锁定就是真的在充；锁定了要电压确实掉够了才算 */
    if (!charger->held) {
        return 1;
    }
    if (charger->full_mv <= 0 && battery_mv > 0) {
        charger->full_mv = battery_mv;
    }
    if (battery_mv > 0 && charger->full_mv > 0 && battery_mv <= charger->full_mv - CHARGE_FULL_HOLD_MV) {
        charger->held = 0;
        charger->full_mv = 0;
        return 1;
    }
    return 2;
}
