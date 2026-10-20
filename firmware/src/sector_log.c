#include "sector_log.h"

#include <string.h>

void sector_log_init(sector_log_t *log, flash_ops_t *ops, uint32_t base_a, uint32_t base_b,
                     uint32_t sector_size)
{
    log->ops = ops;
    log->base_a = base_a;
    log->base_b = base_b;
    log->sector_size = sector_size;
    log->record_size = 32;
}

static int is_blank(const uint8_t *rec, uint16_t size)
{
    uint16_t i;
    for (i = 0; i < size; i++) {
        if (rec[i] != 0xFFu) {
            return 0;
        }
    }
    return 1;
}

static uint32_t read_seq(const uint8_t *rec)
{
    uint32_t seq;
    memcpy(&seq, rec + 4, sizeof seq);
    return seq;
}

static int load_latest(sector_log_t *log, uint8_t *best, int *found, int *sector, uint32_t *offset,
                       sector_log_valid_fn valid)
{
    int s;

    *found = 0;
    *sector = 0;
    *offset = 0;
    for (s = 0; s < 2; s++) {
        uint32_t base = s == 0 ? log->base_a : log->base_b;
        uint32_t off = 0;
        while (off + log->record_size <= log->sector_size) {
            uint8_t rec[32];
            if (log->ops->read(log->ops->ctx, base + off, rec, log->record_size) != 0) {
                return -1;
            }
            if (is_blank(rec, log->record_size)) {
                break;
            }
            if (valid(rec)) {
                uint32_t seq = read_seq(rec);
                if (!*found || seq >= read_seq(best)) {
                    memcpy(best, rec, log->record_size);
                    *found = 1;
                    *sector = s;
                    *offset = off;
                }
            }
            off += log->record_size;
        }
    }
    return 0;
}

int sector_log_load(sector_log_t *log, void *rec, sector_log_valid_fn valid)
{
    uint8_t best[32];
    int found = 0;
    int sector = 0;
    uint32_t offset = 0;

    if (load_latest(log, best, &found, &sector, &offset, valid) != 0) {
        return -1;
    }
    if (!found) {
        return 1;
    }
    memcpy(rec, best, log->record_size);
    return 0;
}

int sector_log_append(sector_log_t *log, const void *rec, sector_log_valid_fn valid)
{
    uint8_t best[32];
    int found = 0;
    int sector = 0;
    uint32_t offset = 0;
    uint32_t base;
    uint32_t dest;
    uint8_t probe[32];

    if (log->record_size != 32 || log->sector_size < 32) {
        return -1;
    }
    if (load_latest(log, best, &found, &sector, &offset, valid) != 0) {
        return -1;
    }
    if (!found) {
        base = log->base_a;
        dest = base;
        if (log->ops->read(log->ops->ctx, dest, probe, log->record_size) != 0) {
            return -1;
        }
        if (!is_blank(probe, log->record_size)) {
            if (log->ops->erase(log->ops->ctx, base) != 0) {
                return -1;
            }
        }
        return log->ops->program(log->ops->ctx, dest, rec, log->record_size);
    }

    base = sector == 0 ? log->base_a : log->base_b;
    dest = base + offset + log->record_size;
    if (dest + log->record_size <= base + log->sector_size) {
        if (log->ops->read(log->ops->ctx, dest, probe, log->record_size) != 0) {
            return -1;
        }
        if (is_blank(probe, log->record_size)) {
            return log->ops->program(log->ops->ctx, dest, rec, log->record_size);
        }
    }

    /* 当前扇区写满或下一格不是空白。旧扇区留下最新记录，擦掉另一侧再写。 */
    base = sector == 0 ? log->base_b : log->base_a;
    if (log->ops->erase(log->ops->ctx, base) != 0) {
        return -1;
    }
    return log->ops->program(log->ops->ctx, base, rec, log->record_size);
}
