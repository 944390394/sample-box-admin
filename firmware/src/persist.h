#ifndef SAMPLE_BOX_PERSIST_H
#define SAMPLE_BOX_PERSIST_H

#include "box.h"
#include "sector_log.h"

/* 0 读到了，1 还没有记录（out 里是出厂状态），-1 读写失败。 */
int persist_load(sector_log_t *log, box_saved_t *out);
int persist_save(sector_log_t *log, const box_saved_t *in);

#endif
