#include "persist.h"

#include "crc16.h"

#include <string.h>

#define PERSIST_MAGIC 0x31545342u

typedef struct __attribute__((packed)) {
    uint32_t magic;
    uint32_t seq;
    uint8_t power_on;
    uint8_t task;
    uint16_t opens;
    uint32_t interval_sec;
    uint32_t phase_origin;
    uint32_t next_wake;
    uint16_t crc;
    uint8_t reserved[6];
} persist_rec_t;

_Static_assert(sizeof(persist_rec_t) == 32, "persist record");

static uint32_t seq_next;

static int persist_valid(const void *rec)
{
    const persist_rec_t *item = rec;
    if (item->magic != PERSIST_MAGIC) {
        return 0;
    }
    return crc16(rec, 24) == item->crc;
}

static void defaults(box_saved_t *out)
{
    memset(out, 0, sizeof *out);
    out->task = BOX_TASK_IDLE;
    out->interval_sec = BOX_INTERVAL_MIN_SEC;
}

int persist_load(sector_log_t *log, box_saved_t *out)
{
    persist_rec_t rec;
    int loaded = sector_log_load(log, &rec, persist_valid);

    if (loaded < 0) {
        return -1;
    }
    if (loaded == 1) {
        defaults(out);
        seq_next = 1;
        return 1;
    }
    out->power_on = rec.power_on ? 1 : 0;
    out->task = (box_task_t)rec.task;
    out->opens = rec.opens;
    out->interval_sec = rec.interval_sec;
    out->phase_origin = rec.phase_origin;
    out->next_wake = rec.next_wake;
    seq_next = rec.seq + 1u;
    return 0;
}

int persist_save(sector_log_t *log, const box_saved_t *in)
{
    persist_rec_t rec;

    if (seq_next == 0) {
        seq_next = 1;
    }
    memset(&rec, 0, sizeof rec);
    rec.magic = PERSIST_MAGIC;
    rec.seq = seq_next;
    rec.power_on = in->power_on ? 1u : 0u;
    rec.task = (uint8_t)in->task;
    rec.opens = in->opens;
    rec.interval_sec = in->interval_sec;
    rec.phase_origin = in->phase_origin;
    rec.next_wake = in->next_wake;
    rec.crc = crc16(&rec, 24);
    if (sector_log_append(log, &rec, persist_valid) != 0) {
        return -1;
    }
    seq_next++;
    return 0;
}
