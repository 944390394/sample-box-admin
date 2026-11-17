#include "event.h"
#include "clock.h"

#ifndef HOST_TEST
static void crit_enter(void)
{
    __asm volatile("cpsid i" ::: "memory");
}

static void crit_exit(void)
{
    __asm volatile("cpsie i" ::: "memory");
}
#else
static void crit_enter(void)
{
}

static void crit_exit(void)
{
}
#endif

void event_init(event_queue_t *queue)
{
    queue->head = 0;
    queue->tail = 0;
    queue->count = 0;
    queue->dropped = 0;
}

void event_post(event_queue_t *queue, event_type_t type)
{
    event_post_lid(queue,type,0);
}

void event_post_lid(event_queue_t *queue, event_type_t type, uint32_t opens)
{
    if (!queue || type == EVENT_NONE) {
        return;
    }
    crit_enter();
    if (queue->count >= EVENT_CAPACITY) {
        queue->dropped++;
        crit_exit();
        return;
    }
    queue->items[queue->head] = type;
    queue->at[queue->head] = clock_ms();
    queue->opens[queue->head] = opens;
    queue->head = (uint8_t)((queue->head + 1u) % EVENT_CAPACITY);
    queue->count++;
    crit_exit();
}

int event_pop(event_queue_t *queue, event_type_t *type)
{
    return event_pop_at(queue,type,0,0);
}

int event_pop_at(event_queue_t *queue, event_type_t *type, uint32_t *at, uint32_t *opens)
{
    crit_enter();
    if (queue->count == 0) {
        crit_exit();
        return 0;
    }
    *type = queue->items[queue->tail];
    if (at) *at = queue->at[queue->tail];
    if (opens) *opens = queue->opens[queue->tail];
    queue->tail = (uint8_t)((queue->tail + 1u) % EVENT_CAPACITY);
    queue->count--;
    crit_exit();
    return 1;
}
