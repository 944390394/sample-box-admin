#ifndef EVENT_H
#define EVENT_H

#include <stdint.h>

/* 队列只存类型。采样值在处理事件时再读，避免在中断里做 ADC。 */
typedef enum {
    EVENT_NONE = 0,
    EVENT_BOOT,
    EVENT_TIMER,
    EVENT_LID_OPEN,
    EVENT_LID_CLOSE,
    EVENT_CHARGE,
} event_type_t;

enum { EVENT_CAPACITY = 16 };

typedef struct {
    event_type_t items[EVENT_CAPACITY];
    uint32_t at[EVENT_CAPACITY];
    uint32_t opens[EVENT_CAPACITY];
    uint8_t head;
    uint8_t tail;
    uint8_t count;
    uint32_t dropped;
} event_queue_t;

void event_init(event_queue_t *queue);
void event_post(event_queue_t *queue, event_type_t type);
void event_post_lid(event_queue_t *queue, event_type_t type, uint32_t opens);
int event_pop_at(event_queue_t *queue, event_type_t *type, uint32_t *at, uint32_t *opens);
int event_pop(event_queue_t *queue, event_type_t *type);

#endif
