#ifndef SAMPLE_BOX_SECTOR_LOG_H
#define SAMPLE_BOX_SECTOR_LOG_H

#include "flash_ops.h"

#include <stdint.h>

/*
 * 两个扇区来回写的快照日志。记录必须是 32 字节，偏移 4 处是递增的 uint32 序号。
 * 擦掉旧扇区时，另一扇区还留着上一份，掉电不会把状态擦没。
 */
typedef int (*sector_log_valid_fn)(const void *rec);

typedef struct {
    flash_ops_t *ops;
    uint32_t base_a;
    uint32_t base_b;
    uint32_t sector_size;
    uint16_t record_size;
} sector_log_t;

void sector_log_init(sector_log_t *log, flash_ops_t *ops, uint32_t base_a, uint32_t base_b,
                     uint32_t sector_size);
int sector_log_load(sector_log_t *log, void *rec, sector_log_valid_fn valid);
int sector_log_append(sector_log_t *log, const void *rec, sector_log_valid_fn valid);

#endif
