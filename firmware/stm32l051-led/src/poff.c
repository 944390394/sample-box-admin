#include "clock.h"
#include "gd25.h"
#include "poff.h"
#include "timebase.h"

#define RECORD 16u
#define KIND_ALIVE 1u
#define KIND_FALL 2u
#define KIND_BOOT 3u
#define KIND_OPEN 4u
#define SAVE_MS 600000ull

#define PWR_CR (*(volatile uint32_t *)0x40007000u)
#define PWR_CSR (*(volatile uint32_t *)0x40007004u)
#define RCC_APB1ENR (*(volatile uint32_t *)0x40021038u)
#define PVD_BELOW (1u << 2)

static uint32_t g_next;
static uint64_t g_last_ms;
static uint64_t g_saved_ms;
static uint32_t g_opens;
static uint8_t g_ready;
static uint8_t g_has;
static uint8_t g_fall_saved;

static int pvd_is_low(void);

static void store_u64(uint8_t *dst, uint64_t value)
{
    unsigned index;
    for (index = 0; index < 8u; index++) {
        dst[index] = (uint8_t)value;
        value >>= 8;
    }
}

static uint64_t load_u64(const uint8_t *src)
{
    uint64_t value = 0;
    int index;
    for (index = 7; index >= 0; index--) {
        value = (value << 8) | src[index];
    }
    return value;
}

static void store_u32(uint8_t *dst, uint32_t value)
{
    unsigned index;
    for (index = 0; index < 4u; index++) {
        dst[index] = (uint8_t)value;
        value >>= 8;
    }
}

static uint32_t load_u32(const uint8_t *src)
{
    return (uint32_t)src[0] | ((uint32_t)src[1] << 8) | ((uint32_t)src[2] << 16) | ((uint32_t)src[3] << 24);
}

static int blank_at(uint32_t addr)
{
    uint8_t head = 0;
    gd25_read(addr, &head, 1u);
    return head == 0xFFu;
}

static void remember(uint32_t addr)
{
    uint8_t rec[RECORD];
    gd25_read(addr, rec, RECORD);
    if (rec[0] != 0xA5u) {
        return;
    }
    g_last_ms = load_u64(rec + 4);
    if (g_last_ms != 0u) {
        g_has = 1;
    }
    g_opens = load_u32(rec + 12);
}

static void locate(void)
{
    uint32_t sector;
    uint32_t used = 0;
    uint32_t offset;
    g_next = 0;
    for (sector = 0; sector < (GD25_LOG_LIMIT / GD25_SECTOR); sector++) {
        if (blank_at(sector * GD25_SECTOR)) {
            break;
        }
        used = sector + 1u;
    }
    if (used == 0u) {
        return;
    }
    g_next = (used - 1u) * GD25_SECTOR;
    for (offset = 0; offset < GD25_SECTOR; offset += RECORD) {
        uint32_t addr = (used - 1u) * GD25_SECTOR + offset;
        if (blank_at(addr)) {
            g_next = addr;
            if (offset > 0u) {
                remember(addr - RECORD);
            } else if (used > 1u) {
                remember(addr - RECORD);
            }
            return;
        }
    }
    g_next = used * GD25_SECTOR;
    remember(g_next - RECORD);
}

static int write_record(uint64_t stamp, uint8_t kind, uint8_t lid, uint8_t charge, int keep_previous)
{
    uint8_t rec[RECORD];
    unsigned index;
    if (!g_ready) {
        return 0;
    }
    if (g_next >= GD25_LOG_LIMIT) {
        if (pvd_is_low()) {
            return 0;
        }
        if (!gd25_erase_sector(0u)) {
            return 0;
        }
        g_next = 0;
    }
    if ((g_next & (GD25_SECTOR - 1u)) == 0u && !blank_at(g_next)) {
        if (pvd_is_low()) {
            return 0;
        }
        if (!gd25_erase_sector(g_next)) {
            return 0;
        }
    }
    for (index = 0; index < RECORD; index++) {
        rec[index] = 0;
    }
    rec[0] = 0xA5u;
    rec[1] = kind;
    rec[2] = lid;
    rec[3] = charge;
    store_u64(rec + 4, stamp);
    store_u32(rec + 12, g_opens);
    if (!gd25_page_program(g_next, rec, RECORD)) {
        return 0;
    }
    if (!keep_previous && stamp != 0u) {
        g_last_ms = stamp;
        g_has = 1;
    }
    g_next += RECORD;
    return 1;
}

static int append(uint64_t stamp, uint8_t kind)
{
    if (stamp == 0u) {
        return 0;
    }
    return write_record(stamp, kind, 0u, 0u, 0);
}

static void pvd_arm(void)
{
    #ifndef HOST_TEST
    RCC_APB1ENR |= 1u << 28;
    PWR_CR = (PWR_CR & ~(7u << 5)) | (6u << 5) | (1u << 4);
    #endif
}

static int pvd_is_low(void)
{
    #ifdef HOST_TEST
    extern int test_power_low;
    return test_power_low;
    #else
    return (PWR_CSR & PVD_BELOW) != 0u;
    #endif
}

void poff_init(void)
{
    g_next = g_last_ms = g_saved_ms = g_opens = 0;
    g_ready = g_has = g_fall_saved = 0;
    pvd_arm();
    if (!gd25_init()) {
        return;
    }
    g_ready = 1;
    locate();
}

void poff_note_boot(int lid_open, int charge)
{
    uint64_t stamp = timebase_synced() ? timebase_now() : 0;
    uint8_t level = charge < 0 ? 0u : (uint8_t)charge;
    write_record(stamp, KIND_BOOT, lid_open ? 1u : 0u, level, 1);
}

uint32_t poff_opens(void)
{
    return g_opens;
}

int poff_note_opens(uint32_t opens)
{
    uint32_t kept = g_opens;
    g_opens = opens;
    if (write_record(g_last_ms, KIND_OPEN, 0u, 0u, 1)) {
        return 1;
    }
    g_opens = kept;
    return 0;
}

void poff_poll(void)
{
    uint64_t now;
    if (!g_ready || !timebase_synced()) {
        return;
    }
    now = timebase_now();
    if (pvd_is_low()) {
        if (!g_fall_saved && append(now, KIND_FALL)) {
            g_fall_saved = 1;
            g_saved_ms = now;
        }
        return;
    }
    g_fall_saved = 0;
    if (g_saved_ms != 0u && (now - g_saved_ms) < SAVE_MS) {
        return;
    }
    if (append(now, KIND_ALIVE)) {
        g_saved_ms = now;
    }
}

int poff_has(void)
{
    return g_has;
}

uint64_t poff_ms(void)
{
    return g_last_ms;
}

int poff_ready(void)
{
    return g_ready;
}

int poff_power_low(void)
{
    return pvd_is_low();
}

uint32_t poff_free(void)
{
    if (!g_ready || g_next >= GD25_LOG_LIMIT) {
        return 0;
    }
    return GD25_LOG_LIMIT - g_next;
}

int poff_erase_log(uint32_t *sector, int full)
{
    uint32_t count = GD25_LOG_LIMIT / GD25_SECTOR;
    if (!g_ready || pvd_is_low()) {
        return -1;
    }
    while (!full && *sector < count && blank_at(*sector * GD25_SECTOR)) {
        (*sector)++;
    }
    if (*sector < count) {
        if (!gd25_erase_sector(*sector * GD25_SECTOR)) {
            return -1;
        }
        (*sector)++;
        if (*sector < count) {
            return 0;
        }
    }
    g_next = g_opens = 0;
    g_last_ms = g_saved_ms = 0;
    g_has = g_fall_saved = 0;
    return 1;
}

uint32_t poff_log_next(void)
{
    return g_next;
}

uint32_t poff_log_total(void)
{
    uint32_t sector;
    uint32_t total = 0;
    if (!g_ready) {
        return 0;
    }
    for (sector = 0; sector < (GD25_LOG_LIMIT / GD25_SECTOR); sector++) {
        if (!blank_at(sector * GD25_SECTOR)) {
            total += GD25_SECTOR / RECORD;
        }
    }
    if (g_next < GD25_LOG_LIMIT && (g_next & (GD25_SECTOR - 1u)) != 0u) {
        total -= (GD25_SECTOR - (g_next & (GD25_SECTOR - 1u))) / RECORD;
    }
    return total;
}
