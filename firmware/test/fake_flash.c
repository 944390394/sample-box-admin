#include "fake_flash.h"

#include <string.h>

#define FAKE_FLASH_SIZE (64u * 1024u)

static uint8_t mem[FAKE_FLASH_SIZE];
static uint32_t erase_size = 4096;
static flash_ops_t ops;

static int read_mem(void *ctx, uint32_t addr, void *buf, uint32_t len)
{
    (void)ctx;
    if (addr + len > FAKE_FLASH_SIZE) {
        return -1;
    }
    memcpy(buf, mem + addr, len);
    return 0;
}

static int program_mem(void *ctx, uint32_t addr, const void *buf, uint32_t len)
{
    const uint8_t *src = buf;
    uint32_t i;
    (void)ctx;
    if (addr + len > FAKE_FLASH_SIZE) {
        return -1;
    }
    for (i = 0; i < len; i++) {
        mem[addr + i] &= src[i];
    }
    return 0;
}

static int erase_mem(void *ctx, uint32_t addr)
{
    uint32_t base;
    (void)ctx;
    if (erase_size == 0 || (addr + erase_size) < addr) {
        return -1;
    }
    base = addr & ~(erase_size - 1u);
    if (base + erase_size > FAKE_FLASH_SIZE) {
        return -1;
    }
    memset(mem + base, 0xFF, erase_size);
    return 0;
}

void fake_flash_reset(uint32_t sector)
{
    erase_size = sector;
    memset(mem, 0xFF, sizeof mem);
    ops.ctx = 0;
    ops.read = read_mem;
    ops.program = program_mem;
    ops.erase = erase_mem;
}

flash_ops_t *fake_flash_ops(void)
{
    return &ops;
}

uint8_t *fake_flash_mem(void)
{
    return mem;
}
