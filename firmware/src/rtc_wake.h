#ifndef SAMPLE_BOX_RTC_WAKE_H
#define SAMPLE_BOX_RTC_WAKE_H

#include <stdint.h>

int rtc_wake_init(void);
uint32_t rtc_seconds(void);
void rtc_schedule(uint32_t target_sec);
void rtc_disarm(void);
/* 1：这次醒来该交给采样箱状态机。0：还没到目标时间，或不是 RTC 唤醒。 */
int rtc_due(void);

#endif
