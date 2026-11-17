#ifndef CLOCK_H
#define CLOCK_H

#include <stdint.h>

#include "charger.h"
#include "event.h"
#include "lid.h"

/* SysTick 1 ms。确认包可以改周期，也可以改成只在充电时投递 EVENT_TIMER。 */
void clock_start(lid_t *lid, charger_t *charger, event_queue_t *events, uint32_t period_ms);
void clock_set_period(uint32_t period_ms);
void clock_set_charge_only(int enabled);
uint32_t clock_ms(void);
uint32_t clock_period_seconds(void);
uint32_t clock_policy_version(void);
int clock_charge_only(void);
/* 指示灯日常是否点亮，只存 RAM，开机默认亮；服务器每包确认都会重发。 */
void clock_set_lights(int on);
int clock_lights_on(void);
/*
 * 模块经串口写来的链路状态行 net=<0|1>。本次开机收到过之后以它为准，不再看 RDY 引脚。
 * 在线要求最近一次是 1 且距收到时刻小于 CLOCK_LINK_STALE_MS，模块任务崩溃时不会一直当在线。
 */
#define CLOCK_LINK_STALE_MS 180000u
void clock_note_link(int up);
int clock_link_seen(void);
int clock_link_online(void);
void clock_set_policy_version(uint32_t version);
void clock_reset_policy(void);
uint32_t clock_next_report_ms(void);
/*
 * c=1（只在充电时上报）时，用电池期间不再完全停报，改为每 CLOCK_BATTERY_PERIOD_MS 报一次定时，
 * 离线期间也有记录可补传；周期比它长时按周期报。
 */
#define CLOCK_BATTERY_PERIOD_MS 600000u
/* 模块写来 gps=1（刚定位成功）时马上补一条定时上报，带上坐标；两次之间至少隔 CLOCK_REQUEST_GAP_MS。 */
#define CLOCK_REQUEST_GAP_MS 60000u
void clock_request_report(void);

/*
 * 改按外部计数走时：read 返回 LPTIM1 的 16 位计数（1024 Hz）。传 0 退回 SysTick 每次加 1 毫秒。
 * 计数连着 50 毫秒不动（晶振停了）会自动退回 SysTick，clock_ticks_lost() 变成 1。
 */
void clock_follow_ticks(uint32_t (*read)(void));
int clock_ticks_lost(void);
/* 低功耗等级，上报里带 lp=：0 不休眠，1 只用 Sleep，2 已用 Stop。 */
void clock_note_power(int level);
int clock_power_level(void);

#endif
