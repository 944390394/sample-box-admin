#ifndef SAMPLE_BOX_JOURNAL_H
#define SAMPLE_BOX_JOURNAL_H

#include "flash_ops.h"
#include "sector_log.h"

#include <stdint.h>

typedef struct {
    uint32_t meta_a;
    uint32_t meta_b;
    uint32_t data_base;
    uint32_t data_size;
    uint32_t erase_size;
} journal_geom_t;

typedef struct {
    uint32_t seq;
    uint8_t why;
    uint8_t lid_open;
    uint16_t opens;
    uint16_t mv;
    uint32_t rtc_sec;
} journal_event_t;

typedef struct journal {
    flash_ops_t *ops;
    sector_log_t meta_log;
    uint32_t data_base;
    uint32_t data_size;
    uint32_t erase_size;
    uint32_t capacity;
    uint32_t write_index;
    uint32_t read_index;
    uint32_t count;
    uint32_t seq_next;
    uint32_t meta_seq;
} journal_t;

/* 挂载已有数据。几何不合法或读写失败返回 -1。 */
int journal_init(journal_t *journal, flash_ops_t *ops, const journal_geom_t *geom);
int journal_append(journal_t *journal, journal_event_t *event);
/* 0 有记录，1 空，-1 错误。 */
int journal_peek(const journal_t *journal, journal_event_t *event);
int journal_ack(journal_t *journal, uint32_t seq);
uint32_t journal_next_seq(const journal_t *journal);
uint32_t journal_count(const journal_t *journal);

#endif
