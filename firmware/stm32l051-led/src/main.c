#include "battery.h"
#include "board.h"
#include "box_app.h"
#include "charger.h"
#include "clock.h"
#include "console.h"
#include "curve.h"
#include "event.h"
#include "factory_reset.h"
#include "gpio.h"
#include "led.h"
#include "lid.h"
#include "modem.h"
#include "poff.h"
#include "power.h"
#include "remote.h"
#include "store.h"

static event_queue_t events;
static led_t led;
static lid_t lid;
static charger_t charger;
static modem_t modem;
static box_app_t app;

/*
 * 能不能进 Stop：没有待处理的事件，箱盖、充电、按键都没在变，模块就绪时实时上报都发完了、补传没在发、
 * 也没在回传日志。power_idle 会在关中断后再问一次。
 * 插着充电器（USB 供电）时不进 Stop：耗电由充电器出，充电灯的闪烁节拍才准，USB 串口也能随时收命令。
 */
static int can_stop(void)
{
    int ready = modem_is_ready();
    return events.count == 0u && charger_status() == 0 && !console_busy() && lid_settled(&lid) && charger_settled(&charger) && factory_reset_idle() &&
           (!ready || (modem.count == 0u && !store_sending() && !remote_wants_line()));
}

int main(void)
{
    gpio_ports_enable();
    event_init(&events);
    led_init(&led);
    lid_init(&lid, &events);
    charger_init(&charger, &events);
    battery_init();
    console_init();
    modem_init(&modem);
    box_app_init(&app, &events, &led, &lid, &charger, &modem);
    clock_start(&lid, &charger, &events, BOARD_REPORT_PERIOD_MS);
    poff_init();
    curve_init();
    store_init();
    factory_reset_init(&led);
    lid.opens = poff_opens();
    poff_note_boot(lid_is_open(&lid), charger_status());
    power_init();

    for (;;) {
        box_app_poll(&app);
        power_idle(can_stop);
    }
}
