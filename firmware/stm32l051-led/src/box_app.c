#include "battery.h"
#include "board.h"
#include "box_app.h"
#include "charger.h"
#include "curve.h"
#include "clock.h"
#include "console.h"
#include "poff.h"
#include "remote.h"
#include "radio.h"
#include "store.h"
#include "timebase.h"
#include "factory_reset.h"

volatile char box_last_line[BOX_LINE];
volatile uint32_t box_seq_value;
volatile uint32_t box_opens_value;
volatile uint32_t box_pending_value;
volatile uint32_t box_lid_open;
volatile uint32_t box_charging;
volatile uint32_t box_ready;

static void publish_line(const char *line)
{
    unsigned index = 0;
    while (line[index] != '\0' && index + 1u < BOX_LINE) {
        box_last_line[index] = line[index];
        index++;
    }
    box_last_line[index] = '\0';
}

static const char *why_of(event_type_t type)
{
    if (type == EVENT_BOOT) {
        return "boot";
    }
    if (type == EVENT_LID_OPEN) {
        return "pad";
    }
    if (type == EVENT_LID_CLOSE) {
        return "shut";
    }
    if (type == EVENT_CHARGE) {
        return "chg";
    }
    if (type == EVENT_TIMER) {
        return "timer";
    }
    return 0;
}

static void remember_opens(box_app_t *app)
{
    if (app->lid->opens != poff_opens()) {
        poff_note_opens(app->lid->opens);
    }
}

static int emit(box_app_t *app, event_type_t type, uint32_t at, uint32_t opens)
{
    const char *why = why_of(type);
    int charge;
    int lid_open;
    uint32_t open_age_s = 0;
    int has_open_age;
    int has_time;
    uint64_t stamp;
    int has_poff;
    uint64_t poff;
    int has_free;
    uint32_t free_bytes;
    int battery_mv;
    int learn_hi = 0;
    int learn_lo = 0;
    int learn_n = 0;
    int has_learn;
    if (!why) {
        return -1;
    }
    battery_mv = battery_millivolts();
    charge = charger_view(app->charger, battery_mv);
    lid_open = lid_is_open(app->lid);
    has_open_age = lid_open_age(app->lid, clock_ms(), &open_age_s);
    has_time = timebase_synced();
    stamp = has_time ? timebase_now() - (uint32_t)(clock_ms()-at) : 0;
    if (type == EVENT_LID_OPEN || type == EVENT_LID_CLOSE) lid_open = type == EVENT_LID_OPEN;
    else opens = app->lid->opens;
    has_poff = type == EVENT_BOOT && poff_has();
    poff = has_poff ? poff_ms() : 0;
    has_free = poff_ready();
    free_bytes = has_free ? poff_free() + store_free() : 0;
    curve_observe(battery_mv, charge);
    has_learn = curve_learned(&learn_hi, &learn_lo, &learn_n);
    if (report_compose(&app->report, why, opens, lid_open, has_open_age, open_age_s, charge,
                       battery_mv, has_time, stamp, has_poff, poff, has_free, free_bytes, has_learn,
                       learn_hi, learn_lo, learn_n, app->line, BOX_LINE) != 0) {
        return -1;
    }
    if (type == EVENT_TIMER) radio_attach_fix(app->line, sizeof app->line);
    publish_line(app->line);
    console_write(app->line);
    if (type == EVENT_BOOT) {
        modem_submit_boot(app->modem, app->line);
    } else {
        modem_submit(app->modem, app->line);
    }
    app->sent_ms = clock_ms();
    box_seq_value = app->report.seq;
    box_opens_value = app->lid->opens;
    box_pending_value = app->modem->count;
    return 0;
}

/** 服务器指令和日志回传。回传行不进补传队列，实时上报与补传优先，空闲时 1 行/秒。 */
static void serve_remote(box_app_t *app, int ready)
{
    store_cmd_t cmd;
    remote_ctx_t ctx;
    while (store_take_cmd(&cmd)) {
        remote_apply(&cmd, app->report.seq);
    }
    remote_poll();
    if (!ready || app->modem->count != 0u || !remote_wants_line() || !store_stream_ready()) {
        return;
    }
    ctx.opens = app->lid->opens;
    ctx.lid_open = lid_is_open(app->lid);
    ctx.battery_mv = battery_millivolts();
    ctx.charge = charger_view(app->charger, ctx.battery_mv);
    if (remote_next_line(&app->report, &ctx, app->line, BOX_LINE)) {
        store_stream(app->line);
    }
}

void box_app_init(box_app_t *app, event_queue_t *events, led_t *led, lid_t *lid, charger_t *charger, modem_t *modem)
{
    app->events = events;
    app->led = led;
    app->lid = lid;
    app->charger = charger;
    app->modem = modem;
    app->line[0] = '\0';
    app->boot_sent = 0;
    app->rdy_since = 0;
    app->sent_ms = 0;
    report_init(&app->report);
}

void box_app_poll(box_app_t *app)
{
    event_type_t type;
    int battery_mv = battery_millivolts();
    int charge = charger_view(app->charger, battery_mv);
    int lid_open = lid_is_open(app->lid);
    int ready = modem_is_ready();
    int light = LED_CHARGE_NONE;
    uint32_t now;

    if (factory_reset_poll()) return;

    box_lid_open = lid_open ? 1u : 0u;
    box_charging = charge == 1 ? 1u : 0u;
    box_ready = ready ? 1u : 0u;
    if (charge == 2) {
        light = LED_CHARGE_FULL;
    } else if (charge == 1) {
        light = battery_mv > 0 && battery_mv < LED_CHARGE_LOW_MV ? LED_CHARGE_LOW : LED_CHARGE_ON;
    }
    led_show(app->led, lid_open, light, ready);
    {
        console_state_t view;
        view.seq = app->report.seq;
        view.opens = app->lid->opens;
        view.lid_open = lid_open;
        view.charge = charge;
        view.battery_mv = battery_mv;
        view.ready = ready;
        view.last_line = app->line;
        console_poll(&view);
    }
    store_poll(ready);
    poff_poll();
    now = clock_ms();
    if (!ready) {
        app->rdy_since = 0;
    } else if (app->rdy_since == 0u) {
        app->rdy_since = now == 0u ? 1u : now;
    }
    /*
     * 复位后第一行经常在模块开始收串口之前就写出去了。
     * 等它主动对时，或 RDY 稳定一段时间，再发 why=boot。
     */
    if (!app->boot_sent && ready) {
        int stable = (now - app->rdy_since) >= BOARD_BOOT_HOLD_MS;
        int waited = now >= BOARD_NTP_WAIT_MS;
        if (timebase_synced() || stable || waited) {
            if (emit(app, EVENT_BOOT, now, app->lid->opens) == 0) {
                app->boot_sent = 1;
            }
        }
    }
    modem_flush(app->modem);
    serve_remote(app, ready);
    box_pending_value = store_pending() + app->modem->count;
    /* 没有待发的实时和补传、最近 3 秒没写过上报，才算安静 */
    battery_poll(app->modem->count == 0u && store_pending() == 0u && (clock_ms() - app->sent_ms) >= 3000u);
    remember_opens(app);

    uint32_t event_at, opens;
    while (event_pop_at(app->events, &type, &event_at, &opens)) {
        if (type == EVENT_BOOT) {
            continue;
        }
        emit(app, type, event_at, opens);
        radio_event(type, charge);
    }
    radio_poll(charge, app->boot_sent && !store_pending() && !app->modem->count && !remote_busy() && store_stream_ready() && (clock_ms()-app->sent_ms >= 3000u));
    remember_opens(app);
}
