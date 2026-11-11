#include "board.h"
#include "clock.h"
#include "gpio.h"
#include "lid.h"

#define LID_IDLE 0u
#define LID_DEBOUNCE_OPEN 1u
#define LID_HELD 2u
#define LID_DEBOUNCE_CLOSE 3u

void lid_init(lid_t *lid, event_queue_t *queue)
{
    lid->queue = queue;
    lid->opens = 0;
    lid->last_open_ms = 0;
    lid->has_open = 0;
    lid->low_ms = 0;
    /* 板上 R4 470k 上拉；内部上拉（约 40k）开盖期间会多耗约 80 µA，默认不开 */
    gpio_set_input(BOARD_PORT_B, BOARD_PIN_LID, BOARD_LID_INTERNAL_PULLUP ? GPIO_PULL_UP : GPIO_PULL_NONE);
    if (!gpio_read(BOARD_PORT_B, BOARD_PIN_LID)) {
        lid->phase = LID_HELD;
    } else {
        lid->phase = LID_IDLE;
    }
}

void lid_on_level(lid_t *lid, int pin_low)
{
    if (pin_low) {
        if (lid->phase == LID_HELD || lid->phase == LID_DEBOUNCE_CLOSE) {
            lid->phase = LID_HELD;
            lid->low_ms = 0;
            return;
        }
        if (lid->phase != LID_DEBOUNCE_OPEN) {
            lid->phase = LID_DEBOUNCE_OPEN;
            lid->low_ms = 0;
        }
        lid->low_ms++;
        if (lid->low_ms >= BOARD_LID_DEBOUNCE_MS) {
            lid->phase = LID_HELD;
            lid->low_ms = 0;
            lid->opens++;
            event_post_lid(lid->queue, EVENT_LID_OPEN, lid->opens);
        }
        return;
    }

    if (lid->phase == LID_IDLE || lid->phase == LID_DEBOUNCE_OPEN) {
        lid->phase = LID_IDLE;
        lid->low_ms = 0;
        return;
    }
    if (lid->phase != LID_DEBOUNCE_CLOSE) {
        lid->phase = LID_DEBOUNCE_CLOSE;
        lid->low_ms = 0;
    }
    lid->low_ms++;
    if (lid->low_ms >= BOARD_LID_DEBOUNCE_MS) {
        lid->phase = LID_IDLE;
        lid->low_ms = 0;
        event_post_lid(lid->queue, EVENT_LID_CLOSE, lid->opens);
    }
}

void lid_on_ms(lid_t *lid)
{
    uint32_t before = lid->opens;
    lid_on_level(lid, !gpio_read(BOARD_PORT_B, BOARD_PIN_LID));
    if (lid->opens != before) {
        lid->last_open_ms = clock_ms();
        lid->has_open = 1;
    }
}

int lid_settled(const lid_t *lid)
{
    int pin_low = !gpio_read(BOARD_PORT_B, BOARD_PIN_LID);
    if (lid->phase == LID_IDLE) {
        return !pin_low;
    }
    if (lid->phase == LID_HELD) {
        return pin_low;
    }
    return 0;
}

int lid_is_open(const lid_t *lid)
{
    return lid->phase == LID_HELD || lid->phase == LID_DEBOUNCE_CLOSE;
}

int lid_open_age(const lid_t *lid, uint32_t now_ms, uint32_t *age_s)
{
    if (!lid->has_open) {
        return 0;
    }
    *age_s = (now_ms - lid->last_open_ms) / 1000u;
    return 1;
}
