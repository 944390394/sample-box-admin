#include "curve.h"
#include "gd25.h"
#include "poff.h"

/*
 * 学习曲线单独占芯片最后一扇区，不写进掉电日志，也不写进离线补传。
 * 扇区里按 48 字节追加。记满后整扇区擦掉，只留下最新一条。
 */
#define CURVE_RECORD 48u
#define CURVE_MAGIC0 0xB1u
#define CURVE_MAGIC1 0x7Cu
#define CURVE_MAX 8u
#define CURVE_SPAN 300

static int g_ready;
static uint32_t g_next;
static uint8_t g_count;
static uint8_t g_phase;
static int g_full_mv;
static int g_min_mv;
static uint16_t g_full[CURVE_MAX];
static uint16_t g_empty[CURVE_MAX];

static void put_u16(uint8_t *dst, int value)
{
    uint16_t bits = value < 0 ? 0u : (uint16_t)value;
    dst[0] = (uint8_t)bits;
    dst[1] = (uint8_t)(bits >> 8);
}

static int get_u16(const uint8_t *src)
{
    return (int)src[0] | ((int)src[1] << 8);
}

static int record_ok(const uint8_t *rec)
{
    return rec[0] == CURVE_MAGIC0 && rec[1] == CURVE_MAGIC1 && rec[2] <= CURVE_MAX && rec[3] <= 2u;
}

static void remember(const uint8_t *rec)
{
    unsigned index;
    g_count = rec[2];
    g_phase = rec[3];
    g_full_mv = get_u16(rec + 4);
    g_min_mv = get_u16(rec + 6);
    for (index = 0; index < g_count; index++) {
        g_full[index] = (uint16_t)get_u16(rec + 8u + index * 4u);
        g_empty[index] = (uint16_t)get_u16(rec + 10u + index * 4u);
    }
}

static void load(void)
{
    uint32_t offset;
    g_next = GD25_CURVE_BASE;
    g_count = 0;
    g_phase = 0;
    g_full_mv = 0;
    g_min_mv = 0;
    for (offset = 0; offset + CURVE_RECORD <= GD25_SECTOR; offset += CURVE_RECORD) {
        uint8_t rec[CURVE_RECORD];
        gd25_read(GD25_CURVE_BASE + offset, rec, CURVE_RECORD);
        if (!record_ok(rec)) {
            g_next = GD25_CURVE_BASE + offset;
            return;
        }
        remember(rec);
        g_next = GD25_CURVE_BASE + offset + CURVE_RECORD;
    }
}

static int save(void)
{
    uint8_t rec[CURVE_RECORD];
    unsigned index;
    if (!g_ready || poff_power_low()) {
        return 0;
    }
    if (g_next + CURVE_RECORD > GD25_CURVE_BASE + GD25_SECTOR) {
        if (!gd25_erase_sector(GD25_CURVE_BASE)) {
            return 0;
        }
        g_next = GD25_CURVE_BASE;
    }
    for (index = 0; index < CURVE_RECORD; index++) {
        rec[index] = 0;
    }
    rec[0] = CURVE_MAGIC0;
    rec[1] = CURVE_MAGIC1;
    rec[2] = g_count;
    rec[3] = g_phase;
    put_u16(rec + 4, g_full_mv);
    put_u16(rec + 6, g_min_mv);
    for (index = 0; index < g_count; index++) {
        put_u16(rec + 8u + index * 4u, g_full[index]);
        put_u16(rec + 10u + index * 4u, g_empty[index]);
    }
    if (!gd25_page_program(g_next, rec, CURVE_RECORD)) {
        return 0;
    }
    g_next += CURVE_RECORD;
    return 1;
}

int curve_factory_reset(void)
{
    if (!g_ready || poff_power_low() || !gd25_erase_sector(GD25_CURVE_BASE)) return 0;
    load();
    return g_count == 0 && g_phase == 0;
}

static int median_of(const uint16_t *values, int count)
{
    uint16_t sorted[CURVE_MAX];
    int left;
    int right;
    int middle;
    if (count <= 0) {
        return 0;
    }
    for (left = 0; left < count; left++) {
        sorted[left] = values[left];
    }
    for (left = 1; left < count; left++) {
        uint16_t key = sorted[left];
        right = left - 1;
        while (right >= 0 && sorted[right] > key) {
            sorted[right + 1] = sorted[right];
            right--;
        }
        sorted[right + 1] = key;
    }
    middle = count / 2;
    if ((count % 2) == 1) {
        return sorted[middle];
    }
    return ((int)sorted[middle - 1] + (int)sorted[middle]) / 2;
}

static void push_cycle(void)
{
    unsigned index;
    if (g_count == CURVE_MAX) {
        for (index = 1; index < CURVE_MAX; index++) {
            g_full[index - 1u] = g_full[index];
            g_empty[index - 1u] = g_empty[index];
        }
        g_count = CURVE_MAX - 1u;
    }
    g_full[g_count] = (uint16_t)g_full_mv;
    g_empty[g_count] = (uint16_t)g_min_mv;
    g_count++;
}

void curve_init(void)
{
    g_ready = 0;
    if (!poff_ready()) {
        return;
    }
    g_ready = 1;
    load();
}

void curve_observe(int millivolts, int charge)
{
    int phase = (int)g_phase;
    int count = (int)g_count;
    int min_before = g_min_mv;
    if (!g_ready || millivolts <= 0 || charge < 0) {
        return;
    }
    if (charge == 2) {
        g_phase = 1u;
        g_full_mv = millivolts;
        g_min_mv = millivolts;
    } else if (g_phase == 1u && millivolts > 4000) {
        return;
    } else if (g_phase == 1u && charge == 0) {
        g_phase = 2u;
        g_min_mv = millivolts;
    } else if (g_phase == 1u) {
        g_phase = 0u;
        g_full_mv = 0;
        g_min_mv = 0;
    } else if (g_phase == 2u && charge == 0) {
        if (millivolts < g_min_mv) {
            g_min_mv = millivolts;
        }
    } else if (g_phase == 2u && charge == 1) {
        if (g_full_mv > 0 && g_min_mv > 0 && g_full_mv - g_min_mv >= CURVE_SPAN) {
            push_cycle();
        }
        g_phase = 0u;
        g_full_mv = 0;
        g_min_mv = 0;
    }
    if (g_phase != phase || (int)g_count != count || (g_phase == 2u && min_before - g_min_mv >= 50)) {
        save();
    }
}

int curve_learned(int *full_mv, int *empty_mv, int *count)
{
    if (g_count == 0u) {
        return 0;
    }
    if (full_mv) {
        *full_mv = median_of(g_full, g_count);
    }
    if (empty_mv) {
        *empty_mv = median_of(g_empty, g_count);
    }
    if (count) {
        *count = g_count;
    }
    return 1;
}
