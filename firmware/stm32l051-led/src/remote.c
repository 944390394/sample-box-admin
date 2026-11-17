#include "factory_reset.h"
#include "gd25.h"
#include "poff.h"
#include "remote.h"

#define RECORD 16u
#define SLOTS_PER_SECTOR (GD25_SECTOR / RECORD)
#define SECTORS (GD25_LOG_LIMIT / GD25_SECTOR)
#define LOG_SLOTS (SECTORS * SLOTS_PER_SECTOR)
/* 每圈最多看这么多个槽，避免整片日志扫描卡住主循环。 */
#define SCAN_BUDGET 64u
#define WHY_MAX 220u

typedef enum { DUMP_IDLE, DUMP_COUNT, DUMP_SEND } dump_phase_t;

typedef struct {
    uint8_t kind;
    uint32_t sec;
    uint32_t opens;
} entry_t;

typedef struct {
    char *cursor;
    char *end;
} text_t;

static dump_phase_t g_phase;
static uint8_t g_info_due;
static uint32_t g_from;
static uint32_t g_limit;
static uint32_t g_req;
static uint32_t g_start;
static uint32_t g_cursor;
static uint32_t g_first;
static uint32_t g_total;
static uint32_t g_sent;
static uint32_t g_parts;
static uint32_t g_part;
static uint8_t g_batch_n;
static entry_t g_batch[REMOTE_DUMP_PER_LINE];

/* 日志按扇区顺序写、写满回绕：最旧的一条在写指针之后的下一个扇区。 */
static uint32_t oldest_slot(void)
{
    uint32_t next = poff_log_next();
    uint32_t sector = next / GD25_SECTOR;
    if ((next & (GD25_SECTOR - 1u)) != 0u) {
        sector++;
    }
    return (sector % SECTORS) * SLOTS_PER_SECTOR;
}

/** 读第 g_cursor 个槽并前进；空白扇区一次跳过整个扇区。返回 1 表示得到一条有效记录。 */
static int next_record(entry_t *out)
{
    uint8_t rec[RECORD];
    uint64_t stamp = 0;
    uint32_t addr = ((g_start + g_cursor) % LOG_SLOTS) * RECORD;
    int index;
    g_cursor++;
    gd25_read(addr, rec, RECORD);
    if (rec[0] == 0xFFu && (addr & (GD25_SECTOR - 1u)) == 0u) {
        g_cursor += SLOTS_PER_SECTOR - 1u;
        return 0;
    }
    if (rec[0] != 0xA5u) {
        return 0;
    }
    for (index = 11; index >= 4; index--) {
        stamp = (stamp << 8) | rec[index];
    }
    out->kind = rec[1];
    out->sec = (uint32_t)(stamp / 1000u);
    out->opens = (uint32_t)rec[12] | ((uint32_t)rec[13] << 8) | ((uint32_t)rec[14] << 16) | ((uint32_t)rec[15] << 24);
    return 1;
}

static void dump_start(const store_cmd_t *cmd)
{
    g_from = cmd->from;
    g_limit = cmd->max > REMOTE_DUMP_MAX ? REMOTE_DUMP_MAX : cmd->max;
    g_req = cmd->req;
    g_start = oldest_slot();
    g_cursor = 0;
    g_first = 0;
    g_total = 0;
    g_sent = 0;
    g_parts = 0;
    g_part = 0;
    g_batch_n = 0;
    g_phase = DUMP_COUNT;
}

int remote_apply(const store_cmd_t *cmd, uint32_t last_seq)
{
    if (cmd->seq != last_seq) {
        return 0;
    }
    if (cmd->kind == STORE_CMD_WIPE) {
        return factory_reset_wipe(cmd->full);
    }
    if (cmd->kind == STORE_CMD_DUMP_INFO) {
        g_info_due = 1;
        return 1;
    }
    if (cmd->kind == STORE_CMD_DUMP && cmd->max != 0u) {
        dump_start(cmd);
        return 1;
    }
    return 0;
}

/** 先数一遍有多少条，part 的总数要在第一行就写出来。 */
static void count_step(void)
{
    unsigned budget;
    for (budget = 0; budget < SCAN_BUDGET && g_cursor < LOG_SLOTS && g_total < g_limit; budget++) {
        uint32_t at = g_cursor;
        entry_t entry;
        if (next_record(&entry) && entry.sec >= g_from) {
            if (g_total == 0u) {
                g_first = at;
            }
            g_total++;
        }
    }
    if (g_cursor < LOG_SLOTS && g_total < g_limit) {
        return;
    }
    g_parts = (g_total + REMOTE_DUMP_PER_LINE - 1u) / REMOTE_DUMP_PER_LINE;
    if (g_parts == 0u) {
        g_parts = 1u;
    }
    g_cursor = g_first;
    g_phase = DUMP_SEND;
}

static int batch_done(void)
{
    return g_batch_n == REMOTE_DUMP_PER_LINE || g_sent + g_batch_n >= g_total || g_cursor >= LOG_SLOTS;
}

void remote_poll(void)
{
    unsigned budget;
    if (g_phase == DUMP_COUNT) {
        count_step();
        return;
    }
    for (budget = 0; g_phase == DUMP_SEND && budget < SCAN_BUDGET && !batch_done(); budget++) {
        entry_t entry;
        if (next_record(&entry) && entry.sec >= g_from) {
            g_batch[g_batch_n++] = entry;
        }
    }
}

int remote_busy(void) { return g_info_due || g_phase != DUMP_IDLE; }

int remote_wants_line(void)
{
    return g_info_due || (g_phase == DUMP_SEND && batch_done());
}

static void put_char(text_t *text, char value)
{
    if (text->cursor < text->end) {
        *text->cursor++ = value;
    }
}

static void put_text(text_t *text, const char *value)
{
    while (*value != '\0') {
        put_char(text, *value++);
    }
}

static void put_u32(text_t *text, uint32_t value)
{
    char digits[10];
    int count = 0;
    do {
        digits[count++] = (char)('0' + (value % 10u));
        value /= 10u;
    } while (value > 0u);
    while (count > 0) {
        put_char(text, digits[--count]);
    }
}

static int compose(report_t *report, const remote_ctx_t *ctx, const char *why, char *dst, unsigned cap)
{
    return report_compose(report, why, ctx->opens, ctx->lid_open, 0, 0u, ctx->charge, ctx->battery_mv, 0, 0u, 0, 0u,
                          0, 0u, 0, 0, 0, 0, dst, cap);
}

int remote_next_line(report_t *report, const remote_ctx_t *ctx, char *dst, unsigned cap)
{
    char why[WHY_MAX + 1u];
    text_t text;
    unsigned shown;
    unsigned index;
    if (g_info_due) {
        text.cursor = why;
        text.end = why + WHY_MAX;
        put_text(&text, "dumpinfo,total=");
        put_u32(&text, poff_log_total());
        *text.cursor = '\0';
        if (compose(report, ctx, why, dst, cap) != 0) {
            return 0;
        }
        g_info_due = 0;
        return 1;
    }
    if (!remote_wants_line()) {
        return 0;
    }
    /* 条目数字很大时整行可能超过 cap：少放几条，剩下的留给下一行。 */
    for (shown = g_batch_n; ; shown--) {
        text.cursor = why;
        text.end = why + WHY_MAX;
        put_text(&text, "dump,r=");
        put_u32(&text, g_req);
        put_text(&text, ",part=");
        put_u32(&text, g_part + 1u);
        put_char(&text, '/');
        put_u32(&text, g_parts > g_part ? g_parts : g_part + 1u);
        put_text(&text, ",d=");
        for (index = 0; index < shown; index++) {
            if (index > 0u) {
                put_char(&text, ';');
            }
            put_u32(&text, g_batch[index].kind);
            put_char(&text, ':');
            put_u32(&text, g_batch[index].sec);
            put_char(&text, ':');
            put_u32(&text, g_batch[index].opens);
        }
        *text.cursor = '\0';
        if (compose(report, ctx, why, dst, cap) == 0) {
            break;
        }
        if (shown <= 1u) {
            return 0;
        }
    }
    for (index = shown; index < g_batch_n; index++) {
        g_batch[index - shown] = g_batch[index];
    }
    g_sent += shown;
    g_batch_n = (uint8_t)(g_batch_n - shown);
    g_part++;
    if (g_batch_n == 0u && (g_sent >= g_total || g_cursor >= LOG_SLOTS)) {
        g_phase = DUMP_IDLE;
    }
    return 1;
}
