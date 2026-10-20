#include "link.h"

#include "board.h"
#include "delay.h"
#include "lpuart.h"
#include "protocol.h"

static void apply_line(box_t *box, journal_t *journal, int have_journal, const char *line, int *cmds)
{
    proto_msg_t msg;
    box_cmd_t cmd;

    if (protocol_parse(line, &msg) != 0) {
        return;
    }
    if (msg.kind == PROTO_KIND_ACK) {
        if (have_journal) {
            journal_ack(journal, msg.seq);
        }
        return;
    }
    cmd.type = msg.cmd;
    cmd.has_interval = msg.has_interval;
    cmd.interval_sec = msg.interval_sec;
    box_apply_command(box, &cmd);
    (*cmds)++;
}

int link_poll(box_t *box, journal_t *journal, int have_journal, uint32_t wait_ms)
{
    uint32_t start = millis();
    int cmds = 0;

    while ((millis() - start) < wait_ms) {
        char line[PROTOCOL_LINE_MAX + 1];
        int n = lpuart_read_line(line, sizeof line, 20);
        if (n > 0) {
            apply_line(box, journal, have_journal, line, &cmds);
        }
    }
    return cmds;
}

static void write_line(const char *line, int length)
{
    static const uint8_t crlf[2] = {'\r', '\n'};
    if (length <= 0) {
        return;
    }
    lpuart_write((const uint8_t *)line, (size_t)length);
    lpuart_write(crlf, 2);
}

int link_send(box_t *box, journal_t *journal, int have_journal, const box_plan_t *plan, uint16_t mv,
              uint32_t now, int rdy)
{
    int i;
    int sent = 0;
    uint32_t mark = 1;
    (void)box;

    if (have_journal) {
        mark = journal_next_seq(journal);
        for (i = 0; i < plan->report_count; i++) {
            journal_event_t event;
            event.why = (uint8_t)plan->reports[i].why;
            event.lid_open = plan->reports[i].lid_open;
            event.opens = plan->reports[i].opens;
            event.mv = mv;
            event.rtc_sec = now;
            event.seq = 0;
            if (journal_append(journal, &event) != 0) {
                break;
            }
        }
        if (!rdy) {
            return 0;
        }
        while (sent < BOARD_SEND_BURST) {
            journal_event_t event;
            char line[128];
            int n;
            int cached;
            if (journal_peek(journal, &event) != 0) {
                break;
            }
            cached = event.seq < mark;
            n = protocol_format(box_why_name((box_why_t)event.why), event.lid_open, event.opens, event.seq,
                                cached, event.mv, line, sizeof line);
            write_line(line, n);
            if (BOARD_DROP_WHEN_MODEM_ACCEPTS) {
                if (journal_ack(journal, event.seq) != 0) {
                    break;
                }
            }
            sent++;
        }
        return link_poll(box, journal, have_journal, 500);
    }

    if (!rdy) {
        return 0;
    }
    for (i = 0; i < plan->report_count; i++) {
        char line[128];
        int n = protocol_format(box_why_name(plan->reports[i].why), plan->reports[i].lid_open,
                                plan->reports[i].opens, (uint32_t)(i + 1), 0, mv, line, sizeof line);
        write_line(line, n);
    }
    return link_poll(box, 0, 0, 500);
}
