#ifndef LID_H
#define LID_H

#include <stdint.h>

#include "event.h"

/*
 * PB10 外部上拉，空闲为高。拉低表示箱盖打开。
 * 连续 30 ms 为低才算一次开箱；连续 30 ms 松开上报关箱，不增加次数。
 * 上电时已经开着或已经关着，都不计这一次。
 */
typedef struct {
    event_queue_t *queue;
    uint32_t opens;
    uint32_t last_open_ms;
    uint8_t has_open;
    uint8_t phase;
    uint8_t low_ms;
} lid_t;

void lid_init(lid_t *lid, event_queue_t *queue);
void lid_on_ms(lid_t *lid);
void lid_on_level(lid_t *lid, int pin_low);
int lid_is_open(const lid_t *lid);
/* 引脚和已确认的开关状态一致、没有正在去抖：可以进 Stop。 */
int lid_settled(const lid_t *lid);
int lid_open_age(const lid_t *lid, uint32_t now_ms, uint32_t *age_s);

#endif
