#ifndef BATTERY_H
#define BATTERY_H

#include <stdint.h>

/* 安静时（最近没有发数据）每隔这么久测一次电压并记下来。 */
#define BATTERY_SAMPLE_MS 10000u
/* 记下的电压在这段时间内都直接用；太旧才在上报时现测。 */
#define BATTERY_FRESH_MS 300000u

/* 用内部基准算出的 VDDA 不在 1.8–3.6 V、读数作废的次数（本次启动累计），和最近一次算出的 VDDA（毫伏）。 */
extern uint32_t battery_bad_ref;
extern uint32_t battery_vdda_mv;

void battery_init(void);
/* quiet：模块最近没有在发数据。只有安静时才测，避开发射时的压降。 */
void battery_poll(int quiet);
int battery_millivolts(void);

#endif
