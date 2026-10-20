#include "adc_vbat.h"
#include "board.h"
#include "box.h"
#include "clock.h"
#include "delay.h"
#include "inputs.h"
#include "journal.h"
#include "link.h"
#include "lpuart.h"
#include "module.h"
#include "persist.h"
#include "pins.h"
#include "power.h"
#include "rtc_wake.h"
#include "spi_port.h"
#include "storage_map.h"

#include "stm32l0xx.h"

static int wait_rdy(box_t *box, journal_t *journal, int have_journal)
{
    uint32_t start = millis();
    int rdy = 0;
    while ((millis() - start) < BOARD_RDY_WAIT_MS) {
        link_poll(box, journal, have_journal, 50);
        if (module_rdy()) {
            rdy = 1;
            break;
        }
    }
    if (rdy) {
        link_poll(box, journal, have_journal, BOARD_DOWNLINK_QUIET_MS);
    }
    return rdy;
}

static uint32_t now_sec(void)
{
    uint32_t now = rtc_seconds();
    return now;
}

int main(void)
{
    box_t box;
    journal_t journal;
    sector_log_t state_log;
    gd25_t flash;
    spi_bus_t bus;
    flash_ops_t ops;
    journal_geom_t geom;
    box_saved_t saved;
    int have_flash = 0;
    int have_journal = 0;

    if (clock_init() != 0) {
        pins_clocks();
        leds_init();
        leds_blink_all();
    }
    if (rtc_wake_init() != 0) {
        pins_clocks();
        leds_init();
        leds_blink_all();
    }

    pins_clocks();
    leds_init();
    spi_port_init(&bus, &flash);
    module_pins_init();
    if (gd25_init(&flash) == 0) {
        gd25_as_flash(&ops, &flash);
        sector_log_init(&state_log, &ops, STORAGE_STATE_A, STORAGE_STATE_B, STORAGE_ERASE);
        if (persist_load(&state_log, &saved) >= 0) {
            have_flash = 1;
        }
        geom.meta_a = STORAGE_META_A;
        geom.meta_b = STORAGE_META_B;
        geom.data_base = STORAGE_DATA_BASE;
        geom.data_size = STORAGE_DATA_SIZE;
        geom.erase_size = STORAGE_ERASE;
        if (journal_init(&journal, &ops, &geom) == 0) {
            have_journal = 1;
        }
    }
    if (!have_flash) {
        saved.power_on = 0;
        saved.task = BOX_TASK_IDLE;
        saved.opens = 0;
        saved.interval_sec = BOX_INTERVAL_MIN_SEC;
        saved.phase_origin = 0;
        saved.next_wake = 0;
    }

    module_apply_saved(saved.power_on);
    lpuart_init();
    inputs_init();
    box_load(&box, &saved);
    box_set_lid(&box, lid_is_open());
    if (box.power_on) {
        if (box.next_wake == 0u) {
            box.next_wake = box_schedule(&box, now_sec());
        }
        rtc_schedule(box.next_wake);
    }

    for (;;) {
        box_plan_t plan;
        int opened = 0;
        int closed = 0;
        int gesture;
        int session;
        int rdy = 0;
        int late = 0;
        uint16_t mv;
        int queued = have_journal && journal_count(&journal) > 0;

        if (rtc_due()) {
            box_note_alarm(&box);
        }
        gesture = take_button_gesture();
        if (gesture == 2) {
            box_note_long(&box);
        } else if (gesture == 1) {
            box_note_short(&box);
        }
        take_lid_edge(&opened, &closed);
        if (opened) {
            box_note_lid_open(&box);
        }
        if (closed) {
            box_note_lid_shut(&box);
        }

        mv = adc_vbat_mv();
        if (box.pending_long || box.pending_short) {
            leds_show(mv);
        }

        session = box_needs_session(&box);
        if (session) {
            module_begin();
            rdy = wait_rdy(&box, have_journal ? &journal : 0, have_journal);
        }
        box_commit(&box, now_sec(), &plan);

        if (plan.report_count > 0 || (queued && box.power_on)) {
            if (!session) {
                module_begin();
                rdy = wait_rdy(&box, have_journal ? &journal : 0, have_journal);
            }
            late = link_send(&box, have_journal ? &journal : 0, have_journal, &plan, mv, now_sec(), rdy);
            if (late) {
                box_schedule(&box, now_sec());
                plan.dirty = 1;
                plan.arm_timer = box.power_on;
                plan.next_wake = box.next_wake;
            }
        }

        module_end(plan.power_module);
        if (have_flash && plan.dirty) {
            box_export(&box, &saved);
            persist_save(&state_log, &saved);
        }
        if (plan.arm_timer) {
            rtc_schedule(plan.next_wake);
        } else {
            rtc_disarm();
        }
        lid_irq_set(box.power_on);
        power_enter_stop();
        if (clock_init() != 0) {
            leds_blink_all();
        }
    }
}
