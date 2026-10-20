#ifndef SAMPLE_BOX_BATTERY_H
#define SAMPLE_BOX_BATTERY_H

#include <stdint.h>

#define BATTERY_MV_EMPTY 3400u
#define BATTERY_MV_FULL 4200u

/* 4.20V 为 100%，3.40V 为 0%。电芯曲线还没实测，先用这条直线。 */
int battery_percent(uint16_t mv);

/*
 * 低 4 位是灯，bit0 是最下一盏。bit7 表示这一盏要闪，电量过低。
 * 4 盏 ≥75%，3 盏 ≥50%，2 盏 ≥25%，1 盏 ≥5%，再低则 1 盏闪。
 */
int battery_led_mask(int percent);

#endif
