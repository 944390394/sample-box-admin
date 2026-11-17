#ifndef BOX_APP_H
#define BOX_APP_H

#include "charger.h"
#include "event.h"
#include "led.h"
#include "lid.h"
#include "modem.h"
#include "report.h"

#define BOX_LINE 240u

typedef struct {
    event_queue_t *events;
    led_t *led;
    lid_t *lid;
    charger_t *charger;
    modem_t *modem;
    report_t report;
    char line[BOX_LINE];
    uint8_t boot_sent;
    uint32_t rdy_since;
    /* 最近一次往模块写上报的时刻，测电压要离它 3 秒以上 */
    uint32_t sent_ms;
} box_app_t;

void box_app_init(box_app_t *app, event_queue_t *events, led_t *led, lid_t *lid, charger_t *charger, modem_t *modem);
void box_app_poll(box_app_t *app);

#endif
