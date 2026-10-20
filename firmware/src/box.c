#include "box.h"

#include <string.h>

const char *box_why_name(box_why_t why)
{
    switch (why) {
    case BOX_WHY_BOOT:
        return "boot";
    case BOX_WHY_TIMER:
        return "timer";
    case BOX_WHY_PAD:
        return "pad";
    case BOX_WHY_SHUT:
        return "shut";
    case BOX_WHY_SYNC:
        return "sync";
    default:
        return "unknown";
    }
}

uint32_t box_clamp_interval(uint32_t sec)
{
    if (sec < BOX_INTERVAL_MIN_SEC) {
        return BOX_INTERVAL_MIN_SEC;
    }
    return sec;
}

/*
 * 周期从第一次开箱的时刻对齐，不是从这次醒来再加一个间隔。
 * now 落在格子上时，下一次是再往后一格，避免闹钟刚响又约到同一秒。
 */
static uint32_t align_forward(uint32_t origin, uint32_t interval, uint32_t now)
{
    uint32_t elapsed;
    uint32_t steps;

    if (interval == 0) {
        return now;
    }
    if (now < origin) {
        return origin;
    }
    elapsed = now - origin;
    steps = elapsed / interval;
    return origin + (steps + 1u) * interval;
}

uint32_t box_schedule(box_t *box, uint32_t now)
{
    if (!box->power_on) {
        return 0;
    }
    if (box->task == BOX_TASK_REPORTING) {
        box->next_wake = align_forward(box->phase_origin, box->interval_sec, now);
    } else {
        box->next_wake = now + box->interval_sec;
    }
    return box->next_wake;
}

void box_load(box_t *box, const box_saved_t *saved)
{
    memset(box, 0, sizeof *box);
    if (saved != 0) {
        box->power_on = saved->power_on ? 1 : 0;
        box->task = saved->task;
        box->opens = saved->opens;
        box->interval_sec = saved->interval_sec;
        box->phase_origin = saved->phase_origin;
        box->next_wake = saved->next_wake;
    }
    if (box->task != BOX_TASK_ARMED && box->task != BOX_TASK_REPORTING) {
        box->task = BOX_TASK_IDLE;
    }
    box->interval_sec = box_clamp_interval(box->interval_sec);
}

void box_export(const box_t *box, box_saved_t *out)
{
    out->power_on = box->power_on;
    out->task = box->task;
    out->opens = box->opens;
    out->interval_sec = box->interval_sec;
    out->phase_origin = box->phase_origin;
    out->next_wake = box->next_wake;
}

void box_set_lid(box_t *box, int open)
{
    box->lid_open = open ? 1 : 0;
}

void box_note_long(box_t *box)
{
    box->pending_long = 1;
}

void box_note_short(box_t *box)
{
    box->pending_short = 1;
}

void box_note_alarm(box_t *box)
{
    box->pending_alarm = 1;
}

void box_note_lid_open(box_t *box)
{
    box->pending_open = 1;
    box->lid_open = 1;
}

void box_note_lid_shut(box_t *box)
{
    box->pending_shut = 1;
    box->lid_open = 0;
}

void box_apply_command(box_t *box, const box_cmd_t *cmd)
{
    if (cmd == 0) {
        return;
    }
    switch (cmd->type) {
    case BOX_CMD_START:
        /* 已经在上报中的开启只更新间隔，不把任务退回等待第一次开箱。 */
        if (box->task != BOX_TASK_REPORTING) {
            box->task = BOX_TASK_ARMED;
        }
        if (cmd->has_interval) {
            box->interval_sec = box_clamp_interval(cmd->interval_sec);
        }
        break;
    case BOX_CMD_STOP:
        box->task = BOX_TASK_IDLE;
        box->opens = 0;
        box->phase_origin = 0;
        box->pending_open = 0;
        box->pending_shut = 0;
        break;
    case BOX_CMD_RESET:
        box->opens = 0;
        break;
    case BOX_CMD_INTERVAL:
        box->interval_sec = box_clamp_interval(cmd->has_interval ? cmd->interval_sec : 0);
        break;
    default:
        break;
    }
}

int box_needs_session(const box_t *box)
{
    if (box->pending_long) {
        return box->power_on ? 0 : 1;
    }
    if (!box->power_on) {
        return 0;
    }
    if (box->pending_short || box->pending_alarm || box->pending_open) {
        return 1;
    }
    if (box->pending_shut && box->task == BOX_TASK_REPORTING) {
        return 1;
    }
    return 0;
}

static void push_report(box_plan_t *plan, const box_t *box, box_why_t why)
{
    box_report_t *report;

    if (plan->report_count >= BOX_REPORT_MAX) {
        return;
    }
    report = &plan->reports[plan->report_count++];
    report->why = why;
    report->opens = box->opens;
    if (why == BOX_WHY_PAD) {
        report->lid_open = 1;
    } else if (why == BOX_WHY_SHUT) {
        report->lid_open = 0;
    } else {
        report->lid_open = box->lid_open ? 1 : 0;
    }
}

void box_commit(box_t *box, uint32_t now, box_plan_t *plan)
{
    int long_press = box->pending_long;
    int short_press = box->pending_short;
    int alarm = box->pending_alarm;
    int open = box->pending_open;
    int shut = box->pending_shut;

    memset(plan, 0, sizeof *plan);
    if (!long_press && !short_press && !alarm && !open && !shut) {
        /* 链式 RTC 或毛刺唤醒：不要改下一次上报时刻，也不要写闪存。 */
        plan->power_module = box->power_on;
        plan->arm_timer = box->power_on;
        plan->next_wake = box->next_wake;
        return;
    }
    box->pending_long = 0;
    box->pending_short = 0;
    box->pending_alarm = 0;
    box->pending_open = 0;
    box->pending_shut = 0;

    if (long_press) {
        plan->show_leds = 1;
        plan->dirty = 1;
        if (box->power_on) {
            box->power_on = 0;
            plan->power_module = 0;
            plan->arm_timer = 0;
            return;
        }
        box->power_on = 1;
        push_report(plan, box, BOX_WHY_BOOT);
    } else if (!box->power_on) {
        if (short_press) {
            plan->show_leds = 1;
        }
        plan->power_module = 0;
        plan->arm_timer = 0;
        return;
    } else {
        if (short_press) {
            plan->show_leds = 1;
            push_report(plan, box, BOX_WHY_SYNC);
        }
        if (alarm && box->task == BOX_TASK_REPORTING) {
            push_report(plan, box, BOX_WHY_TIMER);
        }
        if (open && (box->task == BOX_TASK_ARMED || box->task == BOX_TASK_REPORTING)) {
            if (box->task == BOX_TASK_ARMED) {
                box->task = BOX_TASK_REPORTING;
                box->phase_origin = now;
            }
            if (box->opens < 65535u) {
                box->opens++;
            }
            push_report(plan, box, BOX_WHY_PAD);
        }
        if (shut && box->task == BOX_TASK_REPORTING) {
            push_report(plan, box, BOX_WHY_SHUT);
        }
    }

    if (!box->power_on) {
        return;
    }
    plan->power_module = 1;
    plan->arm_timer = 1;
    plan->dirty = 1;
    plan->next_wake = box_schedule(box, now);
}
