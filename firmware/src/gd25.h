#ifndef SAMPLE_BOX_GD25_H
#define SAMPLE_BOX_GD25_H

#include "flash_ops.h"

#include <stdint.h>

typedef struct {
    void *ctx;
    int (*xfer)(void *ctx, const uint8_t *tx, uint8_t *rx, uint32_t len);
} spi_bus_t;

typedef struct {
    spi_bus_t *bus;
    /* level 0 选中芯片（CS 拉低），level 1 放开。 */
    void (*cs)(void *ctx, int level);
    void *cs_ctx;
} gd25_t;

/* JEDEC 必须是 GD25Q80C：C8 40 14。 */
int gd25_init(gd25_t *dev);
int gd25_read(gd25_t *dev, uint32_t addr, void *buf, uint32_t len);
int gd25_program(gd25_t *dev, uint32_t addr, const void *buf, uint32_t len);
int gd25_erase_4k(gd25_t *dev, uint32_t addr);
void gd25_as_flash(flash_ops_t *ops, gd25_t *dev);

#endif
