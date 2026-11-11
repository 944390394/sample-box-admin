#include <stdint.h>

#include "event.h"
#include "lid.h"
#include "report.h"

volatile uint32_t logic_result;

static int g_failed;

static void expect(int condition, uint32_t code)
{
    if (!condition && logic_result == 0u) {
        logic_result = code;
        g_failed = 1;
    }
}

static void test_report_sequence(void)
{
    report_t report;
    char line[240];
    report_init(&report);
    expect(report_compose(&report, "boot", 0, 0, 0, 0, 0, 3700, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, line, sizeof line) == 0, 1u);
    expect(report.seq == 1u, 3u);
    expect(report_compose(&report, "pad", 2, 1, 1, 0, 1, 3720, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, line, sizeof line) == 0, 4u);
    expect(report.seq == 2u, 5u);
    expect(report_compose(&report, "timer", 2, 0, 0, 0, 2, 3800, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, line, 8) != 0, 6u);
    expect(report.seq == 2u, 7u);
}

static int line_is(const char *line, const char *expect_text)
{
    while (*expect_text != '\0') {
        if (*line != *expect_text) {
            return 0;
        }
        line++;
        expect_text++;
    }
    return *line == '\0';
}

static void test_report_text(void)
{
    report_t report;
    char line[240];
    report_init(&report);
    report_compose(&report, "boot", 0, 0, 0, 0, 0, 3700, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, line, sizeof line);
    expect(line_is(line, "why=boot,opens=0,lid=0,chg=0,bat=3700,pv=0,rp=0,rc=0,rl=1,rn=0,lp=0,fw=1.0.19,seq=1\r\n"), 8u);
    report_compose(&report, "pad", 2, 1, 1, 35, 1, 3720, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, line, sizeof line);
    expect(line_is(line, "why=pad,opens=2,lid=1,openage=35,chg=1,bat=3720,pv=0,rp=0,rc=0,rl=1,rn=0,lp=0,fw=1.0.19,seq=2\r\n"), 9u);
    report_compose(&report, "boot", 0, 0, 0, 0, 1, 4155, 1, 1792564309000ull, 1, 1792564000000ull, 0, 0, 0, 0, 0, 0, line,
                   sizeof line);
    expect(line_is(line,
                   "why=boot,opens=0,lid=0,chg=1,bat=4155,t=1792564309000,poff=1792564000000,pv=0,rp=0,rc=0,rl=1,rn=0,lp=0,fw=1.0.19,seq=3\r\n"),
           28u);
}

static void test_lid_debounce(void)
{
    event_queue_t queue;
    lid_t lid;
    event_type_t type;
    unsigned i;

    event_init(&queue);
    lid.queue = &queue;
    lid.opens = 0;
    lid.last_open_ms = 0;
    lid.has_open = 0;
    lid.phase = 0;
    lid.low_ms = 0;

    for (i = 0; i < 29u; i++) {
        lid_on_level(&lid, 1);
    }
    expect(lid.opens == 0u, 10u);
    expect(event_pop(&queue, &type) == 0, 11u);
    lid_on_level(&lid, 0);
    expect(lid.opens == 0u, 12u);

    for (i = 0; i < 30u; i++) {
        lid_on_level(&lid, 1);
    }
    expect(lid.opens == 1u, 13u);
    expect(lid_is_open(&lid), 14u);
    expect(event_pop(&queue, &type) == 1 && type == EVENT_LID_OPEN, 15u);
    expect(event_pop(&queue, &type) == 0, 16u);
    lid_on_level(&lid, 1);
    expect(event_pop(&queue, &type) == 0, 17u);
    for (i = 0; i < 29u; i++) {
        lid_on_level(&lid, 0);
    }
    expect(lid_is_open(&lid), 18u);
    expect(lid.opens == 1u, 19u);
    expect(event_pop(&queue, &type) == 0, 20u);
    lid_on_level(&lid, 0);
    expect(!lid_is_open(&lid), 25u);
    expect(lid.opens == 1u, 26u);
    expect(event_pop(&queue, &type) == 1 && type == EVENT_LID_CLOSE, 27u);

    for (i = 0; i < 30u; i++) {
        lid_on_level(&lid, 1);
    }
    expect(lid.opens == 2u, 21u);
    expect(event_pop(&queue, &type) == 1 && type == EVENT_LID_OPEN, 22u);
}

static void test_queue_drops_newest(void)
{
    event_queue_t queue;
    event_type_t type;
    unsigned i;
    event_init(&queue);
    for (i = 0; i < 16u; i++) {
        event_post(&queue, EVENT_TIMER);
    }
    event_post(&queue, EVENT_LID_OPEN);
    expect(queue.dropped == 1u, 23u);
    expect(event_pop(&queue, &type) == 1 && type == EVENT_TIMER, 24u);
}

int main(void)
{
    logic_result = 0;
    test_report_sequence();
    test_report_text();
    test_lid_debounce();
    test_queue_drops_newest();
    if (!g_failed) {
        logic_result = 0xA11u;
    }
    for (;;) {
    }
}
