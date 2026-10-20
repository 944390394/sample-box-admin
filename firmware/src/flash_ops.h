#ifndef SAMPLE_BOX_FLASH_OPS_H
#define SAMPLE_BOX_FLASH_OPS_H

#include <stdint.h>

/*
 * program 只把位从 1 写成 0，调用前目标必须是 0xFF 或接受与运算。
 * erase 擦掉 addr 所在的扇区。
 */
typedef struct flash_ops {
    void *ctx;
    int (*read)(void *ctx, uint32_t addr, void *buf, uint32_t len);
    int (*program)(void *ctx, uint32_t addr, const void *buf, uint32_t len);
    int (*erase)(void *ctx, uint32_t addr);
} flash_ops_t;

#endif
