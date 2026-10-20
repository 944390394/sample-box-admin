#include "battery.h"
#include "box.h"
#include "check.h"
#include "civil_time.h"
#include "crc16.h"
#include "fake_flash.h"
#include "fake_gd25.h"
#include "gd25.h"
#include "journal.h"
#include "persist.h"
#include "protocol.h"
#include "sector_log.h"

#include <stdio.h>
#include <string.h>

int g_checks;
int g_failed;

static void test_crc(void)
{
    static const uint8_t data[] = "123456789";
    EXPECT_EQ(crc16(data, 9), 0x29B1);
}

static void test_civil(void)
{
    EXPECT_EQ(civil_to_seconds(2000, 1, 1, 0, 0, 0), 0);
    EXPECT_EQ(civil_to_seconds(2000, 1, 1, 0, 0, 1), 1);
    EXPECT_EQ(civil_to_seconds(2000, 1, 2, 0, 0, 0), 86400);
    EXPECT_EQ(civil_to_seconds(2000, 3, 1, 0, 0, 0), 60 * 86400);
    EXPECT_EQ(civil_to_seconds(2001, 1, 1, 0, 0, 0), 366 * 86400);
}

static void test_battery(void)
{
    EXPECT_EQ(battery_percent(4200), 100);
    EXPECT_EQ(battery_percent(4000), 75);
    EXPECT_EQ(battery_percent(3800), 50);
    EXPECT_EQ(battery_percent(3600), 25);
    EXPECT_EQ(battery_percent(3440), 5);
    EXPECT_EQ(battery_percent(3439), 4);
    EXPECT_EQ(battery_percent(3400), 0);
    EXPECT_EQ(battery_led_mask(75), 0x0F);
    EXPECT_EQ(battery_led_mask(50), 0x07);
    EXPECT_EQ(battery_led_mask(25), 0x03);
    EXPECT_EQ(battery_led_mask(5), 0x01);
    EXPECT_EQ(battery_led_mask(4), 0x81);
}

static void test_protocol(void)
{
    char line[128];
    proto_msg_t msg;
    int n;

    n = protocol_format("pad", 1, 2, 15, 0, 3800, line, sizeof line);
    EXPECT(n > 0);
    EXPECT(strcmp(line, "why=pad,opens=2,lid=open,seq=15,cached=0,mv=3800") == 0);

    n = protocol_format("shut", 0, 2, 16, 1, 3400, line, sizeof line);
    EXPECT(strcmp(line, "why=shut,opens=2,lid=shut,seq=16,cached=1,mv=3400") == 0);
    EXPECT_EQ(protocol_format("boot", 0, 0, 1, 0, 1, line, 8), -1);

    EXPECT_EQ(protocol_parse("cmd=start", &msg), 0);
    EXPECT_EQ(msg.kind, PROTO_KIND_CMD);
    EXPECT_EQ(msg.cmd, BOX_CMD_START);
    EXPECT_EQ(msg.has_interval, 0);

    EXPECT_EQ(protocol_parse("cmd=start,interval=300", &msg), 0);
    EXPECT_EQ(msg.has_interval, 1);
    EXPECT_EQ(msg.interval_sec, 300);

    EXPECT_EQ(protocol_parse("cmd=stop", &msg), 0);
    EXPECT_EQ(msg.cmd, BOX_CMD_STOP);
    EXPECT_EQ(protocol_parse("cmd=reset", &msg), 0);
    EXPECT_EQ(msg.cmd, BOX_CMD_RESET);
    EXPECT_EQ(protocol_parse("cmd=interval,sec=600", &msg), 0);
    EXPECT_EQ(msg.cmd, BOX_CMD_INTERVAL);
    EXPECT_EQ(msg.interval_sec, 600);
    EXPECT_EQ(protocol_parse("cmd=ack,seq=12", &msg), 0);
    EXPECT_EQ(msg.kind, PROTO_KIND_ACK);
    EXPECT_EQ(msg.seq, 12);
    EXPECT_EQ(protocol_parse("  cmd=stop", &msg), 0);
    EXPECT_EQ(protocol_parse("why=boot,opens=1", &msg), -1);
    EXPECT_EQ(protocol_parse("cmd=nope", &msg), -1);
    EXPECT_EQ(protocol_parse("cmd=ack", &msg), -1);
    EXPECT_EQ(protocol_parse("cmd=start,interval=", &msg), -1);
}

static box_cmd_t command(box_cmd_type_t type, int has_interval, uint32_t sec)
{
    box_cmd_t cmd;
    memset(&cmd, 0, sizeof cmd);
    cmd.type = type;
    cmd.has_interval = has_interval;
    cmd.interval_sec = sec;
    return cmd;
}

static void boot_on(box_t *box, uint32_t now)
{
    box_plan_t plan;
    box_note_long(box);
    box_commit(box, now, &plan);
}

static void test_box(void)
{
    box_t box;
    box_plan_t plan;
    box_saved_t saved;
    box_cmd_t cmd;

    box_load(&box, 0);
    EXPECT_EQ(box.power_on, 0);
    EXPECT_EQ(box.interval_sec, 300);
    box_note_short(&box);
    EXPECT_EQ(box_needs_session(&box), 0);
    box_commit(&box, 1000, &plan);
    EXPECT_EQ(plan.show_leds, 1);
    EXPECT_EQ(plan.report_count, 0);
    EXPECT_EQ(plan.power_module, 0);
    EXPECT_EQ(box.power_on, 0);

    box_note_lid_open(&box);
    box_commit(&box, 1000, &plan);
    EXPECT_EQ(plan.report_count, 0);
    EXPECT_EQ(box.opens, 0);

    box_note_long(&box);
    EXPECT_EQ(box_needs_session(&box), 1);
    box_commit(&box, 1000, &plan);
    EXPECT_EQ(box.power_on, 1);
    EXPECT_EQ(box.task, BOX_TASK_IDLE);
    EXPECT_EQ(plan.report_count, 1);
    EXPECT_EQ(plan.reports[0].why, BOX_WHY_BOOT);
    EXPECT_EQ(plan.show_leds, 1);
    EXPECT_EQ(plan.power_module, 1);
    EXPECT_EQ(plan.arm_timer, 1);
    EXPECT_EQ(plan.next_wake, 1300);
    box_commit(&box, 1100, &plan);
    EXPECT_EQ(plan.report_count, 0);
    EXPECT_EQ(plan.dirty, 0);
    EXPECT_EQ(plan.arm_timer, 1);
    EXPECT_EQ(box.next_wake, 1300);

    box_note_alarm(&box);
    EXPECT_EQ(box_needs_session(&box), 1);
    box_commit(&box, 1300, &plan);
    EXPECT_EQ(plan.report_count, 0);
    EXPECT_EQ(plan.next_wake, 1600);

    cmd = command(BOX_CMD_START, 1, 60);
    box_apply_command(&box, &cmd);
    EXPECT_EQ(box.task, BOX_TASK_ARMED);
    EXPECT_EQ(box.interval_sec, 300);
    cmd = command(BOX_CMD_START, 1, 600);
    box_apply_command(&box, &cmd);
    EXPECT_EQ(box.interval_sec, 600);

    box_note_lid_shut(&box);
    EXPECT_EQ(box_needs_session(&box), 0);
    box_commit(&box, 1400, &plan);
    EXPECT_EQ(plan.report_count, 0);
    EXPECT_EQ(box.task, BOX_TASK_ARMED);

    box_note_lid_open(&box);
    box_commit(&box, 1500, &plan);
    EXPECT_EQ(box.task, BOX_TASK_REPORTING);
    EXPECT_EQ(box.opens, 1);
    EXPECT_EQ(box.phase_origin, 1500);
    EXPECT_EQ(plan.report_count, 1);
    EXPECT_EQ(plan.reports[0].why, BOX_WHY_PAD);
    EXPECT_EQ(plan.reports[0].lid_open, 1);
    EXPECT_EQ(plan.next_wake, 2100);

    box_note_lid_open(&box);
    box_commit(&box, 1600, &plan);
    EXPECT_EQ(box.opens, 2);
    EXPECT_EQ(box.phase_origin, 1500);
    EXPECT_EQ(plan.next_wake, 2100);

    box_note_alarm(&box);
    box_commit(&box, 2100, &plan);
    EXPECT_EQ(plan.report_count, 1);
    EXPECT_EQ(plan.reports[0].why, BOX_WHY_TIMER);
    EXPECT_EQ(plan.reports[0].opens, 2);
    EXPECT_EQ(plan.next_wake, 2700);

    box_note_lid_shut(&box);
    box_commit(&box, 2200, &plan);
    EXPECT_EQ(plan.reports[0].why, BOX_WHY_SHUT);
    EXPECT_EQ(plan.reports[0].opens, 2);
    EXPECT_EQ(plan.reports[0].lid_open, 0);
    EXPECT_EQ(box.opens, 2);

    box_note_short(&box);
    box_commit(&box, 2300, &plan);
    EXPECT_EQ(plan.show_leds, 1);
    EXPECT_EQ(plan.reports[0].why, BOX_WHY_SYNC);

    cmd = command(BOX_CMD_RESET, 0, 0);
    box_apply_command(&box, &cmd);
    EXPECT_EQ(box.opens, 0);
    EXPECT_EQ(box.task, BOX_TASK_REPORTING);
    box_note_alarm(&box);
    box_commit(&box, 2700, &plan);
    EXPECT_EQ(plan.reports[0].why, BOX_WHY_TIMER);
    EXPECT_EQ(plan.reports[0].opens, 0);

    box_note_lid_open(&box);
    cmd = command(BOX_CMD_STOP, 0, 0);
    box_apply_command(&box, &cmd);
    box_commit(&box, 2800, &plan);
    EXPECT_EQ(box.task, BOX_TASK_IDLE);
    EXPECT_EQ(box.opens, 0);
    EXPECT_EQ(plan.report_count, 0);
    EXPECT_EQ(box.power_on, 1);

    cmd = command(BOX_CMD_START, 0, 0);
    box_apply_command(&box, &cmd);
    EXPECT_EQ(box.interval_sec, 600);
    box_note_lid_open(&box);
    box_commit(&box, 3000, &plan);
    EXPECT_EQ(box.opens, 1);
    EXPECT_EQ(box.task, BOX_TASK_REPORTING);

    box_note_long(&box);
    EXPECT_EQ(box_needs_session(&box), 0);
    box_commit(&box, 3100, &plan);
    EXPECT_EQ(box.power_on, 0);
    EXPECT_EQ(box.task, BOX_TASK_REPORTING);
    EXPECT_EQ(box.opens, 1);
    EXPECT_EQ(plan.report_count, 0);
    EXPECT_EQ(plan.power_module, 0);

    box_note_long(&box);
    EXPECT_EQ(box_needs_session(&box), 1);
    box_commit(&box, 4000, &plan);
    EXPECT_EQ(box.power_on, 1);
    EXPECT_EQ(box.opens, 1);
    EXPECT_EQ(plan.reports[0].why, BOX_WHY_BOOT);
    EXPECT_EQ(plan.next_wake, 4200);

    box_load(&box, 0);
    boot_on(&box, 1000);
    box_note_lid_open(&box);
    cmd = command(BOX_CMD_START, 0, 0);
    box_apply_command(&box, &cmd);
    box_commit(&box, 1100, &plan);
    EXPECT_EQ(box.task, BOX_TASK_REPORTING);
    EXPECT_EQ(box.opens, 1);
    EXPECT_EQ(plan.reports[0].why, BOX_WHY_PAD);

    memset(&saved, 0, sizeof saved);
    saved.power_on = 1;
    saved.task = BOX_TASK_REPORTING;
    saved.opens = 4;
    saved.interval_sec = 10;
    saved.phase_origin = 50;
    box_load(&box, &saved);
    EXPECT_EQ(box.interval_sec, 300);
    EXPECT_EQ(box.opens, 4);
    box_export(&box, &saved);
    EXPECT_EQ(saved.opens, 4);
    EXPECT_EQ(saved.task, BOX_TASK_REPORTING);
}

typedef struct __attribute__((packed)) {
    uint32_t magic;
    uint32_t seq;
    uint8_t payload[22];
    uint16_t crc;
} demo_rec_t;

_Static_assert(sizeof(demo_rec_t) == 32, "demo record");

static int demo_valid(const void *rec)
{
    const demo_rec_t *item = rec;
    if (item->magic != 0x314F4D44u) {
        return 0;
    }
    return crc16(rec, 30) == item->crc;
}

static void fill_demo(demo_rec_t *rec, uint32_t seq)
{
    memset(rec, 0, sizeof *rec);
    rec->magic = 0x314F4D44u;
    rec->seq = seq;
    rec->crc = crc16(rec, 30);
}

static void test_sector_log(void)
{
    sector_log_t log;
    demo_rec_t rec;
    demo_rec_t loaded;

    fake_flash_reset(64);
    sector_log_init(&log, fake_flash_ops(), 0, 64, 64);
    EXPECT_EQ(sector_log_load(&log, &loaded, demo_valid), 1);

    fill_demo(&rec, 1);
    EXPECT_EQ(sector_log_append(&log, &rec, demo_valid), 0);
    fill_demo(&rec, 2);
    EXPECT_EQ(sector_log_append(&log, &rec, demo_valid), 0);
    fill_demo(&rec, 3);
    EXPECT_EQ(sector_log_append(&log, &rec, demo_valid), 0);
    EXPECT_EQ(sector_log_load(&log, &loaded, demo_valid), 0);
    EXPECT_EQ(loaded.seq, 3);

    fake_flash_mem()[64] = 0x00;
    EXPECT_EQ(sector_log_load(&log, &loaded, demo_valid), 0);
    EXPECT_EQ(loaded.seq, 2);

    memset(fake_flash_mem() + 64, 0xFF, 64);
    EXPECT_EQ(sector_log_load(&log, &loaded, demo_valid), 0);
    EXPECT_EQ(loaded.seq, 2);
}

static journal_geom_t small_geom(void)
{
    journal_geom_t geom;
    memset(&geom, 0, sizeof geom);
    geom.meta_a = 0;
    geom.meta_b = 64;
    geom.data_base = 128;
    geom.data_size = 128;
    geom.erase_size = 64;
    return geom;
}

static journal_event_t sample_event(uint8_t why, uint16_t opens)
{
    journal_event_t event;
    memset(&event, 0, sizeof event);
    event.why = why;
    event.lid_open = 1;
    event.opens = opens;
    event.mv = 3800;
    event.rtc_sec = 1000 + opens;
    return event;
}

typedef struct {
    flash_ops_t ops;
    flash_ops_t *raw;
    int calls;
    int fail_on;
} flaky_flash_t;

static int flaky_read(void *ctx, uint32_t addr, void *buf, uint32_t len)
{
    flaky_flash_t *flaky = ctx;
    return flaky->raw->read(flaky->raw->ctx, addr, buf, len);
}

static int flaky_program(void *ctx, uint32_t addr, const void *buf, uint32_t len)
{
    flaky_flash_t *flaky = ctx;
    flaky->calls++;
    if (flaky->fail_on != 0 && flaky->calls == flaky->fail_on) {
        return -1;
    }
    return flaky->raw->program(flaky->raw->ctx, addr, buf, len);
}

static int flaky_erase(void *ctx, uint32_t addr)
{
    flaky_flash_t *flaky = ctx;
    return flaky->raw->erase(flaky->raw->ctx, addr);
}

static void test_journal(void)
{
    journal_t journal;
    journal_t again;
    journal_geom_t geom = small_geom();
    journal_event_t event;
    journal_event_t got;
    flaky_flash_t flaky;
    int i;

    fake_flash_reset(64);
    EXPECT_EQ(journal_init(&journal, fake_flash_ops(), &geom), 0);
    EXPECT_EQ(journal_peek(&journal, &got), 1);

    for (i = 1; i <= 4; i++) {
        event = sample_event(BOX_WHY_TIMER, (uint16_t)i);
        EXPECT_EQ(journal_append(&journal, &event), 0);
        EXPECT_EQ(event.seq, (uint32_t)i);
    }
    EXPECT_EQ(journal_count(&journal), 4);
    EXPECT_EQ(journal_peek(&journal, &got), 0);
    EXPECT_EQ(got.seq, 1);
    EXPECT_EQ(journal_ack(&journal, 2), -1);
    EXPECT_EQ(journal_ack(&journal, 1), 0);
    EXPECT_EQ(journal_peek(&journal, &got), 0);
    EXPECT_EQ(got.opens, 2);

    event = sample_event(BOX_WHY_PAD, 9);
    EXPECT_EQ(journal_append(&journal, &event), -1);
    EXPECT_EQ(journal_ack(&journal, 2), 0);
    EXPECT_EQ(journal_append(&journal, &event), 0);
    EXPECT_EQ(event.seq, 5);
    EXPECT_EQ(journal_peek(&journal, &got), 0);
    EXPECT_EQ(got.seq, 3);
    EXPECT_EQ(journal_ack(&journal, 3), 0);
    EXPECT_EQ(journal_ack(&journal, 4), 0);
    EXPECT_EQ(journal_peek(&journal, &got), 0);
    EXPECT_EQ(got.seq, 5);
    EXPECT_EQ(got.why, BOX_WHY_PAD);
    EXPECT_EQ(journal_ack(&journal, 5), 0);
    EXPECT_EQ(journal_peek(&journal, &got), 1);

    fake_flash_reset(64);
    EXPECT_EQ(journal_init(&journal, fake_flash_ops(), &geom), 0);
    for (i = 1; i <= 4; i++) {
        event = sample_event(BOX_WHY_TIMER, (uint16_t)i);
        EXPECT_EQ(journal_append(&journal, &event), 0);
    }
    event = sample_event(BOX_WHY_PAD, 9);
    EXPECT_EQ(journal_append(&journal, &event), 0);
    EXPECT_EQ(event.seq, 5);
    EXPECT_EQ(journal_peek(&journal, &got), 0);
    EXPECT_EQ(got.seq, 3);

    EXPECT_EQ(journal_init(&again, fake_flash_ops(), &geom), 0);
    EXPECT_EQ(journal_peek(&again, &got), 0);
    EXPECT_EQ(got.seq, 3);
    EXPECT_EQ(journal_next_seq(&again), 6);

    fake_flash_reset(64);
    memset(&flaky, 0, sizeof flaky);
    flaky.raw = fake_flash_ops();
    flaky.ops.ctx = &flaky;
    flaky.ops.read = flaky_read;
    flaky.ops.program = flaky_program;
    flaky.ops.erase = flaky_erase;
    flaky.fail_on = 2;
    EXPECT_EQ(journal_init(&journal, &flaky.ops, &geom), 0);
    event = sample_event(BOX_WHY_BOOT, 0);
    EXPECT_EQ(journal_append(&journal, &event), -1);
    EXPECT_EQ(journal_init(&again, fake_flash_ops(), &geom), 0);
    EXPECT_EQ(journal_peek(&again, &got), 0);
    EXPECT_EQ(got.seq, 1);
    EXPECT_EQ(got.why, BOX_WHY_BOOT);
}

static void test_persist(void)
{
    sector_log_t log;
    box_saved_t saved;
    box_saved_t loaded;

    fake_flash_reset(64);
    sector_log_init(&log, fake_flash_ops(), 0, 64, 64);
    EXPECT_EQ(persist_load(&log, &loaded), 1);
    EXPECT_EQ(loaded.power_on, 0);
    EXPECT_EQ(loaded.interval_sec, 300);

    memset(&saved, 0, sizeof saved);
    saved.power_on = 1;
    saved.task = BOX_TASK_ARMED;
    saved.opens = 0;
    saved.interval_sec = 600;
    saved.phase_origin = 0;
    saved.next_wake = 5000;
    EXPECT_EQ(persist_save(&log, &saved), 0);
    saved.opens = 3;
    saved.task = BOX_TASK_REPORTING;
    EXPECT_EQ(persist_save(&log, &saved), 0);
    EXPECT_EQ(persist_load(&log, &loaded), 0);
    EXPECT_EQ(loaded.opens, 3);
    EXPECT_EQ(loaded.task, BOX_TASK_REPORTING);
    EXPECT_EQ(loaded.interval_sec, 600);
    EXPECT_EQ(loaded.next_wake, 5000);
}

static void test_gd25(void)
{
    gd25_t *dev;
    flash_ops_t ops;
    uint8_t buf[300];
    uint8_t back[300];
    uint32_t i;

    fake_gd25_reset();
    dev = fake_gd25_device();
    EXPECT_EQ(gd25_init(dev), 0);
    for (i = 0; i < sizeof buf; i++) {
        buf[i] = (uint8_t)(i + 1u);
    }
    EXPECT_EQ(gd25_program(dev, 200, buf, sizeof buf), 0);
    memset(back, 0, sizeof back);
    EXPECT_EQ(gd25_read(dev, 200, back, sizeof back), 0);
    EXPECT(memcmp(buf, back, sizeof buf) == 0);

    buf[0] = 0xF0;
    EXPECT_EQ(gd25_program(dev, 200, buf, 1), 0);
    EXPECT_EQ(gd25_read(dev, 200, back, 1), 0);
    EXPECT_EQ(back[0], 0x00);

    gd25_as_flash(&ops, dev);
    EXPECT_EQ(ops.erase(ops.ctx, 0), 0);
    EXPECT_EQ(gd25_read(dev, 200, back, 1), 0);
    EXPECT_EQ(back[0], 0xFF);
    EXPECT_EQ(ops.erase(ops.ctx, 100), 0);
}

int main(void)
{
    test_crc();
    test_civil();
    test_battery();
    test_protocol();
    test_box();
    test_sector_log();
    test_journal();
    test_persist();
    test_gd25();
    if (g_failed != 0) {
        fprintf(stderr, "%d checks, %d failed\n", g_checks, g_failed);
        return 1;
    }
    printf("%d checks passed\n", g_checks);
    return 0;
}
