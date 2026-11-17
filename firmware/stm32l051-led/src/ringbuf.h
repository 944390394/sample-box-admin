#ifndef RINGBUF_H
#define RINGBUF_H

#include <stdint.h>

/* 单生产者（中断）单消费者（主循环）。16 位下标在 Cortex-M0+ 上读写不会撕裂。 */
#define RING_SIZE 512u

typedef struct {
    volatile uint16_t head;
    volatile uint16_t tail;
    uint8_t data[RING_SIZE];
} ring_t;

static inline void ring_clear(ring_t *ring)
{
    ring->head = 0;
    ring->tail = 0;
}

/* 满了丢新字节，返回 0。 */
static inline int ring_push(ring_t *ring, uint8_t byte)
{
    uint16_t head = ring->head;
    uint16_t next = (uint16_t)((head + 1u) % RING_SIZE);
    if (next == ring->tail) {
        return 0;
    }
    ring->data[head] = byte;
    ring->head = next;
    return 1;
}

static inline int ring_pop(ring_t *ring, uint8_t *out)
{
    uint16_t tail = ring->tail;
    if (tail == ring->head) {
        return 0;
    }
    *out = ring->data[tail];
    ring->tail = (uint16_t)((tail + 1u) % RING_SIZE);
    return 1;
}

#endif
