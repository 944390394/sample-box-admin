#include "board.h"
#include "report.h"
#include "clock.h"

typedef struct {
    char *cursor;
    char *end;
    int overflow;
} writer_t;

static void write_text(writer_t *writer, const char *text)
{
    while (*text != '\0') {
        if (writer->cursor >= writer->end) {
            writer->overflow = 1;
            return;
        }
        *writer->cursor = *text;
        writer->cursor++;
        text++;
    }
}

static void write_u64(writer_t *writer, uint64_t value)
{
    char digits[20];
    int count = 0;
    if (value == 0u) {
        digits[count++] = '0';
    } else {
        while (value > 0u && count < 20) {
            digits[count++] = (char)('0' + (value % 10u));
            value /= 10u;
        }
    }
    while (count > 0) {
        count--;
        if (writer->cursor >= writer->end) {
            writer->overflow = 1;
            return;
        }
        *writer->cursor = digits[count];
        writer->cursor++;
    }
}

static void write_u32(writer_t *writer, uint32_t value)
{
    write_u64(writer, value);
}

static void write_i32(writer_t *writer, int value)
{
    if (value < 0) {
        write_text(writer, "-");
        write_u32(writer, (uint32_t)(-value));
        return;
    }
    write_u32(writer, (uint32_t)value);
}

void report_init(report_t *report)
{
    report->seq = 0;
}

int report_compose(report_t *report, const char *why, uint32_t opens, int lid_open, int has_open_age,
                   uint32_t open_age_s, int charge, int battery_mv, int has_time, uint64_t time_ms,
                   int has_poff, uint64_t poff_ms, int has_free, uint32_t free_bytes, int has_learn,
                   int learn_hi, int learn_lo, int learn_n, char *dst, unsigned cap)
{
    writer_t writer;
    uint32_t seq = report->seq + 1u;
    if (!why || cap < 2u) {
        return -1;
    }
    writer.cursor = dst;
    writer.end = dst + cap - 1u;
    writer.overflow = 0;
    write_text(&writer, "why=");
    write_text(&writer, why);
    write_text(&writer, ",opens=");
    write_u32(&writer, opens);
    write_text(&writer, ",lid=");
    write_i32(&writer, lid_open ? 1 : 0);
    if (has_open_age) {
        write_text(&writer, ",openage=");
        write_u32(&writer, open_age_s);
    }
    write_text(&writer, ",chg=");
    write_i32(&writer, charge);
    write_text(&writer, ",bat=");
    write_i32(&writer, battery_mv);
    if (has_time) {
        write_text(&writer, ",t=");
        write_u64(&writer, time_ms);
    }
    if (has_poff) {
        write_text(&writer, ",poff=");
        write_u64(&writer, poff_ms);
    }
    if (has_free) {
        write_text(&writer, ",free=");
        write_u32(&writer, free_bytes);
    }
    if (has_learn && learn_n > 0) {
        write_text(&writer, ",hi=");
        write_i32(&writer, learn_hi);
        write_text(&writer, ",lo=");
        write_i32(&writer, learn_lo);
        write_text(&writer, ",n=");
        write_i32(&writer, learn_n);
    }
    write_text(&writer, ",pv=");
    write_u32(&writer, clock_policy_version());
    write_text(&writer, ",rp=");
    write_u32(&writer, clock_period_seconds());
    write_text(&writer, ",rc=");
    write_u32(&writer, (uint32_t)clock_charge_only());
    write_text(&writer, ",rl=");
    write_u32(&writer, (uint32_t)clock_lights_on());
    write_text(&writer, ",rn=");
    write_u32(&writer, (uint32_t)clock_link_seen());
    write_text(&writer, ",lp=");
    write_u32(&writer, (uint32_t)clock_power_level());
    write_text(&writer, ",fw=");
    write_text(&writer, BOARD_FIRMWARE);
    write_text(&writer, ",seq=");
    write_u32(&writer, seq);
    write_text(&writer, "\r\n");
    if (writer.overflow) {
        dst[0] = '\0';
        return -1;
    }
    *writer.cursor = '\0';
    report->seq = seq;
    return 0;
}
