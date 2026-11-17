#ifndef REMOTE_H
#define REMOTE_H

#include <stdint.h>
#include "report.h"
#include "store.h"

/* 回传硬上限，服务器给的 n 再大也不超过。 */
#define REMOTE_DUMP_MAX 20000u
#define REMOTE_DUMP_PER_LINE 7u

/* 回传行里 opens/lid/chg/bat 取自当前状态，字段前缀同普通上报。 */
typedef struct {
    uint32_t opens;
    int lid_open;
    int charge;
    int battery_mv;
} remote_ctx_t;

/*
 * 服务器指令。s 必须等于本机最近一次上报的 seq，否则忽略。
 * wipe 走恢复出厂流程；dump 只在内存里排队，断电或复位后不续传。
 */
int remote_apply(const store_cmd_t *cmd, uint32_t last_seq);
/* 主循环每圈调用：分片扫描日志区，一次只读有限个槽。 */
void remote_poll(void);
/* 有一行要发（dumpinfo 或下一片 dump）。 */
int remote_busy(void);
int remote_wants_line(void);
/* 取下一行，成功返回 1，同时推进 report.seq。 */
int remote_next_line(report_t *report, const remote_ctx_t *ctx, char *dst, unsigned cap);

#endif
