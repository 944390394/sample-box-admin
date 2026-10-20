#ifndef SAMPLE_BOX_CIVIL_TIME_H
#define SAMPLE_BOX_CIVIL_TIME_H

#include <stdint.h>

/* 从 2000-01-01 00:00:00 起算的秒。RTC 只有两位年份，调用方传入 2000–2099。 */
uint32_t civil_to_seconds(int year, int month, int day, int hour, int minute, int second);

#endif
