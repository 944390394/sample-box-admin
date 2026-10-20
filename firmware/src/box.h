#ifndef SAMPLE_BOX_BOX_H
#define SAMPLE_BOX_BOX_H

#include "protocol.h"

#include <stdint.h>

/* 平台开启指令没带间隔时用这个，也是允许的最短间隔。方案里最短 5 分钟。 */
#define BOX_INTERVAL_MIN_SEC 300u

typedef enum {
    BOX_TASK_IDLE = 0,
    BOX_TASK_ARMED = 1,
    BOX_TASK_REPORTING = 2
} box_task_t;

typedef enum {
    BOX_WHY_BOOT = 1,
    BOX_WHY_TIMER = 2,
    BOX_WHY_PAD = 3,
    BOX_WHY_SHUT = 4,
    BOX_WHY_SYNC = 5
} box_why_t;

typedef struct {
    box_cmd_type_t type;
    int has_interval;
    uint32_t interval_sec;
} box_cmd_t;

typedef struct {
    int power_on;
    box_task_t task;
    uint16_t opens;
    uint32_t interval_sec;
    uint32_t phase_origin;
    uint32_t next_wake;
} box_saved_t;

#define BOX_REPORT_MAX 4

typedef struct {
    box_why_t why;
    uint16_t opens;
    uint8_t lid_open;
} box_report_t;

typedef struct {
    int power_module;
    int show_leds;
    int arm_timer;
    int dirty;
    uint32_t next_wake;
    int report_count;
    box_report_t reports[BOX_REPORT_MAX];
} box_plan_t;

typedef struct {
    int power_on;
    box_task_t task;
    uint16_t opens;
    uint32_t interval_sec;
    uint32_t phase_origin;
    uint32_t next_wake;
    int lid_open;
    int pending_long;
    int pending_short;
    int pending_alarm;
    int pending_open;
    int pending_shut;
} box_t;

const char *box_why_name(box_why_t why);
uint32_t box_clamp_interval(uint32_t sec);

void box_load(box_t *box, const box_saved_t *saved);
void box_export(const box_t *box, box_saved_t *out);
void box_set_lid(box_t *box, int open);

void box_note_long(box_t *box);
void box_note_short(box_t *box);
void box_note_alarm(box_t *box);
void box_note_lid_open(box_t *box);
void box_note_lid_shut(box_t *box);

/* 同一轮醒来先收指令再提交。结束指令会丢掉这一轮还没提交的开箱。 */
void box_apply_command(box_t *box, const box_cmd_t *cmd);
int box_needs_session(const box_t *box);
void box_commit(box_t *box, uint32_t now, box_plan_t *plan);

/* 提交之后又收到改间隔或结束时，按当前任务重算下一次醒来。 */
uint32_t box_schedule(box_t *box, uint32_t now);

#endif
