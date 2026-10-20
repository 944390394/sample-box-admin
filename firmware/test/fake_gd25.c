#include "fake_gd25.h"

#include <string.h>

#define CHIP_SIZE (64u * 1024u)
#define PAGE 256u

static uint8_t mem[CHIP_SIZE];
static int cs_level = 1;
static int phase;
static uint8_t cmd;
static int addr_bytes;
static uint32_t addr;
static int wel;
static int page_index;
static uint32_t page_base;
static uint8_t page_data[PAGE];
static uint8_t page_mark[PAGE];
static int id_pos;
static gd25_t device;
static spi_bus_t bus;

static void cs(void *ctx, int level)
{
    (void)ctx;
    if (level == 0) {
        phase = 0;
        addr_bytes = 0;
        addr = 0;
        page_index = 0;
        page_base = 0;
        id_pos = 0;
        memset(page_mark, 0, sizeof page_mark);
        cs_level = 0;
        return;
    }
    if (cs_level == 0 && cmd == 0x02u && wel) {
        int i;
        for (i = 0; i < (int)PAGE; i++) {
            if (page_mark[i]) {
                mem[page_base + (uint32_t)i] &= page_data[i];
            }
        }
        wel = 0;
    } else if (cs_level == 0 && cmd == 0x20u && wel) {
        uint32_t base = addr & ~0xFFFu;
        if (base + 4096u <= CHIP_SIZE) {
            memset(mem + base, 0xFF, 4096u);
        }
        wel = 0;
    }
    cs_level = 1;
    cmd = 0;
}

static int xfer(void *ctx, const uint8_t *tx, uint8_t *rx, uint32_t len)
{
    uint32_t i;
    (void)ctx;
    if (cs_level != 0) {
        return -1;
    }
    for (i = 0; i < len; i++) {
        uint8_t in = tx[i];
        uint8_t out = 0xFF;
        if (phase == 0) {
            cmd = in;
            if (cmd == 0x06u) {
                wel = 1;
            } else if (cmd == 0x9Fu || cmd == 0x05u) {
                phase = 2;
                id_pos = 0;
            } else if (cmd == 0x03u || cmd == 0x02u || cmd == 0x20u) {
                phase = 1;
            } else {
                phase = 2;
            }
        } else if (phase == 1) {
            addr = (addr << 8) | in;
            addr_bytes++;
            if (addr_bytes == 3) {
                phase = 2;
                page_base = addr & ~(PAGE - 1u);
                page_index = (int)(addr & (PAGE - 1u));
            }
        } else if (cmd == 0x9Fu) {
            static const uint8_t id[3] = {0xC8u, 0x40u, 0x14u};
            if (id_pos < 3) {
                out = id[id_pos++];
            }
        } else if (cmd == 0x05u) {
            out = wel ? 0x02u : 0x00u;
        } else if (cmd == 0x03u) {
            if (addr < CHIP_SIZE) {
                out = mem[addr];
            }
            if (addr + 1u > addr) {
                addr++;
            }
        } else if (cmd == 0x02u) {
            page_data[page_index] = in;
            page_mark[page_index] = 1;
            page_index = (page_index + 1) & (int)(PAGE - 1);
        }
        if (rx != 0) {
            rx[i] = out;
        }
    }
    return 0;
}

void fake_gd25_reset(void)
{
    memset(mem, 0xFF, sizeof mem);
    cs_level = 1;
    wel = 0;
    cmd = 0;
    bus.ctx = 0;
    bus.xfer = xfer;
    device.bus = &bus;
    device.cs = cs;
    device.cs_ctx = 0;
}

gd25_t *fake_gd25_device(void)
{
    return &device;
}
