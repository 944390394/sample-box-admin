#ifndef TIMEBASE_H
#define TIMEBASE_H

#include <stdint.h>

/*
 * 模块联网后只写一次 ntp=<unix 毫秒>。
 * 基准是这次的毫秒减去当时的 SysTick，之后每行用基准加当前毫秒。
 * SysTick 是 32 位，这条基准在约 49 天内有效。
 */
void timebase_on_line(const char *line);
int timebase_synced(void);
uint64_t timebase_now(void);

#endif
