#include "gd25.h"

#include <string.h>

#define GD25_PAGE 256u
#define GD25_CMD_WREN 0x06u
#define GD25_CMD_RDSR 0x05u
#define GD25_CMD_READ 0x03u
#define GD25_CMD_PP 0x02u
#define GD25_CMD_SE 0x20u
#define GD25_CMD_RDID 0x9Fu

static int xfer(gd25_t *dev, const uint8_t *tx, uint8_t *rx, uint32_t len)
{
    return dev->bus->xfer(dev->bus->ctx, tx, rx, len);
}

static int write_enable(gd25_t *dev)
{
    uint8_t tx = GD25_CMD_WREN;
    uint8_t rx = 0;
    int rc;

    dev->cs(dev->cs_ctx, 0);
    rc = xfer(dev, &tx, &rx, 1);
    dev->cs(dev->cs_ctx, 1);
    return rc;
}

static int wait_ready(gd25_t *dev)
{
    int i;

    for (i = 0; i < 100000; i++) {
        uint8_t tx[2] = {GD25_CMD_RDSR, 0};
        uint8_t rx[2] = {0, 0};
        dev->cs(dev->cs_ctx, 0);
        if (xfer(dev, tx, rx, 2) != 0) {
            dev->cs(dev->cs_ctx, 1);
            return -1;
        }
        dev->cs(dev->cs_ctx, 1);
        if ((rx[1] & 0x01u) == 0) {
            return 0;
        }
    }
    return -1;
}

int gd25_init(gd25_t *dev)
{
    uint8_t tx[4] = {GD25_CMD_RDID, 0, 0, 0};
    uint8_t rx[4] = {0, 0, 0, 0};
    int rc;

    if (dev == 0 || dev->bus == 0 || dev->cs == 0) {
        return -1;
    }
    dev->cs(dev->cs_ctx, 0);
    rc = xfer(dev, tx, rx, 4);
    dev->cs(dev->cs_ctx, 1);
    if (rc != 0) {
        return -1;
    }
    if (rx[1] != 0xC8u || rx[2] != 0x40u || rx[3] != 0x14u) {
        return -1;
    }
    return 0;
}

int gd25_read(gd25_t *dev, uint32_t addr, void *buf, uint32_t len)
{
    uint8_t hdr[4];
    uint8_t hdr_rx[4];
    uint8_t *out = buf;
    int rc = 0;

    hdr[0] = GD25_CMD_READ;
    hdr[1] = (uint8_t)(addr >> 16);
    hdr[2] = (uint8_t)(addr >> 8);
    hdr[3] = (uint8_t)addr;
    dev->cs(dev->cs_ctx, 0);
    if (xfer(dev, hdr, hdr_rx, 4) != 0) {
        rc = -1;
    }
    while (rc == 0 && len > 0) {
        uint8_t tx[64];
        uint32_t n = len > sizeof tx ? (uint32_t)sizeof tx : len;
        memset(tx, 0xFF, n);
        if (xfer(dev, tx, out, n) != 0) {
            rc = -1;
            break;
        }
        out += n;
        len -= n;
    }
    dev->cs(dev->cs_ctx, 1);
    return rc;
}

static int page_program(gd25_t *dev, uint32_t addr, const uint8_t *data, uint32_t len)
{
    uint8_t hdr[4];
    uint8_t hdr_rx[4];
    uint8_t rx_dump[64];
    int rc = 0;

    if (len == 0 || len > GD25_PAGE) {
        return -1;
    }
    if (write_enable(dev) != 0) {
        return -1;
    }
    hdr[0] = GD25_CMD_PP;
    hdr[1] = (uint8_t)(addr >> 16);
    hdr[2] = (uint8_t)(addr >> 8);
    hdr[3] = (uint8_t)addr;
    dev->cs(dev->cs_ctx, 0);
    if (xfer(dev, hdr, hdr_rx, 4) != 0) {
        rc = -1;
    }
    while (rc == 0 && len > 0) {
        uint32_t n = len > sizeof rx_dump ? (uint32_t)sizeof rx_dump : len;
        if (xfer(dev, data, rx_dump, n) != 0) {
            rc = -1;
            break;
        }
        data += n;
        len -= n;
    }
    dev->cs(dev->cs_ctx, 1);
    if (rc != 0) {
        return -1;
    }
    return wait_ready(dev);
}

int gd25_program(gd25_t *dev, uint32_t addr, const void *buf, uint32_t len)
{
    const uint8_t *data = buf;

    while (len > 0) {
        uint32_t page_off = addr & (GD25_PAGE - 1u);
        uint32_t chunk = GD25_PAGE - page_off;
        if (chunk > len) {
            chunk = len;
        }
        if (page_program(dev, addr, data, chunk) != 0) {
            return -1;
        }
        addr += chunk;
        data += chunk;
        len -= chunk;
    }
    return 0;
}

int gd25_erase_4k(gd25_t *dev, uint32_t addr)
{
    uint8_t tx[4];
    uint8_t rx[4];
    int rc;

    if ((addr & 0xFFFu) != 0) {
        return -1;
    }
    if (write_enable(dev) != 0) {
        return -1;
    }
    tx[0] = GD25_CMD_SE;
    tx[1] = (uint8_t)(addr >> 16);
    tx[2] = (uint8_t)(addr >> 8);
    tx[3] = (uint8_t)addr;
    dev->cs(dev->cs_ctx, 0);
    rc = xfer(dev, tx, rx, 4);
    dev->cs(dev->cs_ctx, 1);
    if (rc != 0) {
        return -1;
    }
    return wait_ready(dev);
}

static int ops_read(void *ctx, uint32_t addr, void *buf, uint32_t len)
{
    return gd25_read(ctx, addr, buf, len);
}

static int ops_program(void *ctx, uint32_t addr, const void *buf, uint32_t len)
{
    return gd25_program(ctx, addr, buf, len);
}

static int ops_erase(void *ctx, uint32_t addr)
{
    return gd25_erase_4k(ctx, addr & ~0xFFFu);
}

void gd25_as_flash(flash_ops_t *ops, gd25_t *dev)
{
    ops->ctx = dev;
    ops->read = ops_read;
    ops->program = ops_program;
    ops->erase = ops_erase;
}
