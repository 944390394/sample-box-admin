#include "board.h"
#include "clock.h"
#include "gd25.h"
#include "poff.h"
#include "store.h"
#include "radio.h"
#include "timebase.h"
#include "uart.h"

#define STORE_BASE GD25_LOG_LIMIT
#define POINTER_BYTES GD25_SECTOR
#define DATA_BASE (STORE_BASE + POINTER_BYTES)
#define SLOT GD25_PAGE
/* 少 16 条，把芯片最后一扇区留给电池曲线，不跟补传记录混放。 */
#define SLOTS 992u
#define KEEP_FREE 16u
/* 间隔短于模块组包时间时，两行 why= 会粘进同一次上传。 */
#define SEND_GAP_MS 1000u
#define RX_LINE 112u
uint32_t store_write_failures;
uint32_t store_overflows;
#define TEXT_MAX 240u
#define STORE_MAGIC 0xA6u
#define POINTER_MAGIC0 0xA7u
#define POINTER_MAGIC1 0x5Au
/* 0x5B 的记录把第 10 字节起的 4 字节当作已发送游标，不再保存存储序号。 */
#define POINTER_MAGIC_SENT 0x5Bu
#define POINTER_MAGIC_CLEAN 0x5Cu
/* 0x5D/0x5E：头、尾、已发送各 2 字节，其后 4 字节存储序号、2 字节队列代号。0x5E 同 0x5C。 */
#define POINTER_MAGIC_V2 0x5Du
#define POINTER_MAGIC_V2_CLEAN 0x5Eu
/* 队列头这么久没前进、又有已发未确认的记录，就把发送指针退回队列头重发。 */
#define RESEND_MS 120000u
#define TAG_MAX 32u
/*
 * 在线先走内存：新上报放进在途环并立即发出，收到 a= 才移除；超过 ACK_WAIT_MS 没确认或链路掉线，
 * 才按序落进 Flash 队列。环里最多 RING_N 条，断电会丢（掉电事件本身记在掉电日志里）。
 */
#define ACK_WAIT_MS 15000u
#define RING_N 6u
/*
 * 积压回传一次最多 BATCH_MAX 条、总长不超过 BATCH_BYTES，首尾相接写串口，之后等 SEND_GAP_MS。
 * 900 取自 DTU 常见的单帧上限（1024 字节）留出余量；实测后可直接改这两个宏。
 */
#define BATCH_MAX 8u
#define BATCH_BYTES 900u
/* 旧固件只保存 128 个编号的预留上限。新格式用指针记录末两字节记下实际已分配的编号。 */
#define LEGACY_QSTEP 128u
#define Q_BLOCK 14u
#define Q_FORMAT 0x4000u
#define Q_UNUSED 0x3fffu
static uint16_t g_qbits;
static uint8_t g_recover_tail = 1;

static uint32_t g_head;
static uint32_t g_tail;
/* 下一个要分配的 q，和已落盘的上限 g_qlimit（所有已分配的 q 都小于它）。 */
static uint32_t g_qnext;
static uint32_t g_qlimit;
static uint8_t g_link;
/* 开机时从落盘上限 L 跳到 L+QSTEP：开机后分到的第一个 q 带 qz=L，告诉服务器 (L, q) 之间的号不存在。 */
static uint8_t g_gap_valid;
static uint32_t g_gap_l;
static uint32_t g_ptr;
static uint32_t g_active_ptr = POINTER_BYTES;
static uint32_t g_sent;
static uint32_t g_sent_at;
static uint32_t g_wait_ms;
/* 队列代号：每次清空队列加 1。放在指针记录里，随每次保存指针一起写，不另占扇区。 */
static uint16_t g_qe;
static uint32_t g_ack_n;
static uint8_t g_ack_has;

typedef struct {
    uint32_t q;
    uint32_t at;
    uint8_t length;
    uint8_t text[TEXT_MAX];
} flight_t;
static flight_t g_ring[RING_N];
static uint8_t g_ring_head;
static uint8_t g_ring_n;
static uint8_t g_ready;
static char g_rx[RX_LINE];
static uint8_t g_rx_len;
static store_cmd_t g_cmd;
static uint8_t g_cmd_ready;

static void store_u32(uint8_t *dst, uint32_t value)
{
    unsigned index;
    for (index = 0; index < 4u; index++) {
        dst[index] = (uint8_t)value;
        value >>= 8;
    }
}

static void store_u16(uint8_t *dst, uint32_t value)
{
    dst[0] = (uint8_t)value;
    dst[1] = (uint8_t)(value >> 8);
}

static uint32_t load_u16(const uint8_t *src)
{
    return (uint32_t)src[0] | ((uint32_t)src[1] << 8);
}

static uint32_t load_u32(const uint8_t *src)
{
    return (uint32_t)src[0] | ((uint32_t)src[1] << 8) | ((uint32_t)src[2] << 16) | ((uint32_t)src[3] << 24);
}

static uint32_t slot_addr(uint32_t index)
{
    return DATA_BASE + index * SLOT;
}

static uint32_t span(uint32_t from, uint32_t to)
{
    return (to + SLOTS - from) % SLOTS;
}

static uint32_t queued(void)
{
    return span(g_head, g_tail);
}

static int sent_in_range(void)
{
    return g_sent < SLOTS && span(g_head, g_sent) <= span(g_head, g_tail);
}

static int save_pointers(void)
{
    uint8_t rec[16], check[16];
    unsigned index;
    if (g_ptr + 16u > POINTER_BYTES) {
        if (poff_power_low() || !gd25_erase_sector(STORE_BASE)) {
            return 0;
        }
        g_ptr = 0;
        g_active_ptr = POINTER_BYTES;
    }
    for (index = 0; index < 16u; index++) {
        rec[index] = 0;
    }
    rec[0] = POINTER_MAGIC0;
    rec[1] = g_recover_tail ? POINTER_MAGIC_V2 : POINTER_MAGIC_V2_CLEAN;
    store_u16(rec + 2, g_head);
    store_u16(rec + 4, g_tail);
    store_u16(rec + 6, g_sent);
    store_u32(rec + 8, g_qlimit);
    store_u16(rec + 12, g_qe);
    store_u16(rec + 14, g_qbits);
    const uint32_t slot = g_ptr;
    g_ptr += 16u;
    /* Publish the header only after the cursor and the allocation bitmap are durable. */
    if (!gd25_page_program(STORE_BASE + slot + 1u, rec + 1, 15u)) return 0;
    gd25_read(STORE_BASE + slot, check, 16u);
    if (check[0] != 0xffu) return 0;
    for (index = 1u; index < 16u; index++) if (check[index] != rec[index]) return 0;
    gd25_page_program(STORE_BASE + slot, rec, 1u);
    gd25_read(STORE_BASE + slot, check, 1u);
    if (check[0] != rec[0]) return 0;
    g_active_ptr = slot;
    return 1;
}

/** 槽头 4..7 字节是这条记录的 q（1.0.9 的槽里是同一个位置，数值等于当时的位置序号）。 */
static int slot_read(uint32_t index, uint8_t *length, uint32_t *q)
{
    uint8_t hdr[8];
    gd25_read(slot_addr(index), hdr, 8u);
    if (hdr[0] != STORE_MAGIC || hdr[1] != 0xFFu || hdr[2] == 0u || hdr[2] > TEXT_MAX) {
        return 0;
    }
    *length = hdr[2];
    *q = load_u32(hdr + 4);
    return 1;
}

static void load_pointers(void)
{
    uint32_t offset;
    uint32_t field = 0;
    uint16_t bits = 0;
    int found = 0;
    int sent_known = 0;
    int legacy = 0;
    int resume;
    g_head = 0;
    g_tail = 0;
    g_sent = 0;
    g_ptr = 0;
    g_active_ptr = POINTER_BYTES;
    g_qe = 0;
    g_recover_tail = 1;
    for (offset = 0; offset + 16u <= POINTER_BYTES; offset += 16u) {
        uint8_t rec[16];
        gd25_read(STORE_BASE + offset, rec, 16u);
        if (rec[0] == 0xFFu) {
            unsigned i = 1u;
            while (i < 16u && rec[i] == 0xffu) i++;
            if (i != 16u) g_ptr = offset + 16u;
            continue; /* reset before the journal entry was committed */
        }
        g_ptr = offset + 16u;
        if (rec[0] != POINTER_MAGIC0) {
            continue;
        }
        if (rec[1] == POINTER_MAGIC_V2 || rec[1] == POINTER_MAGIC_V2_CLEAN) {
            g_head = load_u16(rec + 2);
            g_tail = load_u16(rec + 4);
            g_sent = load_u16(rec + 6);
            field = load_u32(rec + 8);
            bits = (uint16_t)load_u16(rec + 14);
            g_qe = (uint16_t)load_u16(rec + 12);
            g_ptr = offset + 16u;
            g_active_ptr = offset;
            g_recover_tail = rec[1] == POINTER_MAGIC_V2;
            found = 1;
            legacy = 0;
            sent_known = 1;
            continue;
        }
        if (rec[1] != POINTER_MAGIC1 && rec[1] != POINTER_MAGIC_SENT && rec[1] != POINTER_MAGIC_CLEAN) {
            continue;
        }
        g_head = load_u32(rec + 2);
        g_tail = load_u32(rec + 6);
        g_ptr = offset + 16u;
        found = 1;
        legacy = 1;
        g_recover_tail = rec[1] != POINTER_MAGIC_CLEAN;
        if (rec[1] == POINTER_MAGIC_SENT || rec[1] == POINTER_MAGIC_CLEAN) {
            g_sent = load_u32(rec + 10);
            sent_known = 1;
        } else {
            sent_known = 0;
        }
    }
    resume = found;
    if (!found || g_head >= SLOTS || g_tail >= SLOTS) {
        /* 指针损坏时队列内容不可信，换一个队列代号，服务器按新队列重新计。 */
        g_qe = found ? (uint16_t)(g_qe + 1u) : 0u;
        g_head = 0;
        g_tail = 0;
        g_sent = 0;
        sent_known = 1;
        legacy = 0;
        resume = 0;
    }
    if (legacy) {
        /*
         * 1.0.8 以前的槽里没有可用的 q（重启后序号从 0 重来）。升级时换新的队列代号，
         * 已发送未确认的和没发出的都当作已处理丢弃，从空队列开始。
         */
        g_qe = 1u;
        g_head = g_tail;
        g_sent = g_tail;
        sent_known = 1;
        g_recover_tail = 0;
        resume = 0;
    }
    g_qbits = resume ? bits : 0u;
    g_gap_valid = 0;
    g_gap_l = field;
    g_qlimit = resume ? field : 0u;
    g_qnext = g_qlimit;
    if (resume && (bits & ~Q_UNUSED) == Q_FORMAT && field >= Q_BLOCK) {
        /* The highest cleared bit is the last claimed number, even after an interrupted claim. */
        for (uint16_t bit = 1u << (Q_BLOCK - 1u); bit && (bits & bit); bit >>= 1u) {
            --g_qnext;
        }
    } else if (resume && bits == 0u && field <= UINT32_MAX - LEGACY_QSTEP) {
        /* One conservative handover from legacy firmware. Older real records may still arrive. */
        g_qnext = field + LEGACY_QSTEP;
        g_gap_valid = 1u;
    }
    /*
     * 旧记录没有发送游标。ok 到不了串口，这些槽一直算未确认。
     * 上电从队尾接着发，避免把已经上传过的历史按 1 秒一条再倒一遍。
     */
    if (!sent_known || !sent_in_range()) {
        g_sent = g_tail;
    }
}

static int drop_oldest(void)
{
    uint32_t start = (g_head / 16u) * 16u;
    uint32_t next;
    if ((g_tail / 16u) == (start / 16u)) {
        return 0;
    }
    if (poff_power_low() || !gd25_erase_sector(slot_addr(start))) {
        return 0;
    }
    store_overflows++;
    next = start + 16u;
    g_head = next >= SLOTS ? 0u : next;
    if (!sent_in_range()) {
        g_sent = g_head;
    }
    return 1;
}

static int prepare_tail(void)
{
    uint8_t first;
    if ((g_tail % 16u) != 0u) {
        return 1;
    }
    if ((g_head / 16u) == (g_tail / 16u) && g_head != g_tail) {
        return 0;
    }
    gd25_read(slot_addr(g_tail), &first, 1u);
    if (first == 0xFFu) {
        return 1;
    }
    if (poff_power_low()) {
        return 0;
    }
    return gd25_erase_sector(slot_addr(g_tail));
}

static void write_line(const uint8_t *raw, unsigned length, uint32_t q);

/** q 不大于 n（按回绕比较）。 */
static int q_covered(uint32_t q, uint32_t n)
{
    return (n - q) <= 0x7FFFFFFFu;
}

static int reserve_q(void)
{
    if (g_qnext >= g_qlimit) {
        const uint32_t previous = g_qlimit;
        const uint16_t previous_bits = g_qbits;
        if (g_qnext > UINT32_MAX - Q_BLOCK) return 0;
        g_qlimit = g_qnext + Q_BLOCK;
        g_qbits = Q_FORMAT | Q_UNUSED;
        if (!save_pointers()) {
            g_qlimit = previous;
            g_qbits = previous_bits;
            return 0;
        }
    }
    /* Clear a single NOR bit before exposing q on UART or in a slot. No sector erase per claim. */
    const unsigned bit = Q_BLOCK - (g_qlimit - g_qnext);
    const uint16_t next = (uint16_t)(g_qbits & ~(1u << bit));
    if (next == g_qbits) return 1; /* retry of a claimed record whose slot write failed */
    if (g_active_ptr == POINTER_BYTES && !save_pointers()) return 0;
    const unsigned shift = (bit / 8u) * 8u;
    const uint8_t value = (uint8_t)(next >> shift);
    const uint32_t addr = STORE_BASE + g_active_ptr + 14u + bit / 8u;
    if (!gd25_page_program(addr, &value, 1u)) return 0;
    uint8_t readback;
    gd25_read(addr, &readback, 1u);
    if (readback != value) return 0;
    g_qbits = next;
    return 1;
}

/** 写一条记录到 Flash 队列尾，槽头带显式 q。save 为 0 时由调用方统一存指针。 */
static int flash_put(uint32_t q, const uint8_t *text, unsigned length, int save)
{
    uint8_t buf[8u + TEXT_MAX];
    uint8_t first;
    unsigned index;
    if (queued() >= SLOTS - KEEP_FREE && !drop_oldest()) {
        return 0;
    }
    /* 上次写了槽、没来得及存指针（断电）：这一条算进队列，不要在它上面再写。 */
    for (index = 0; index < 16u && (g_tail % 16u) != 0u; index++) {
        gd25_read(slot_addr(g_tail), &first, 1u);
        if (first == 0xFFu) {
            break;
        }
        g_tail = (g_tail + 1u) % SLOTS;
    }
    if (!prepare_tail()) {
        return 0;
    }
    for (index = 0; index < 8u + TEXT_MAX; index++) {
        buf[index] = 0xFFu;
    }
    buf[0] = STORE_MAGIC;
    buf[1] = 0xFFu;
    buf[2] = (uint8_t)length;
    buf[3] = 0;
    store_u32(buf + 4, q);
    for (index = 0; index < length; index++) {
        buf[8u + index] = text[index];
    }
    if (!gd25_page_program(slot_addr(g_tail), buf, 8u + length)) {
        return 0;
    }
    g_tail = (g_tail + 1u) % SLOTS;
    if (save && !save_pointers()) {
        /* The slot has been programmed; retrying the same q would duplicate it. */
        store_write_failures++;
    }
    return 1;
}

static void ring_pop(void)
{
    g_ring_head = (uint8_t)((g_ring_head + 1u) % RING_N);
    g_ring_n--;
}

static void ring_ack(uint32_t n)
{
    while (g_ring_n != 0u && q_covered(g_ring[g_ring_head].q, n)) {
        ring_pop();
    }
}

/** 在途环按序写进 Flash 队列，保持原来的 q；落盘的记录排在待发位置上，链路在线时会重发。 */
static int ring_spill(void)
{
    while (g_ring_n != 0u) {
        flight_t *entry = &g_ring[g_ring_head];
        if (!flash_put(entry->q, entry->text, entry->length, 0)) {
            save_pointers();
            return 0;
        }
        ring_pop();
    }
    save_pointers();
    return 1;
}

static int is_ok(const char *line)
{
    if (!((line[0] == 'o' || line[0] == 'O') && (line[1] == 'k' || line[1] == 'K'))) {
        return 0;
    }
    return line[2] == '\0' || line[2] == ' ';
}

static const char *skip_space(const char *cursor)
{
    while (*cursor == ' ') {
        cursor++;
    }
    return cursor;
}

static int read_u32(const char **cursor, uint32_t *out)
{
    const char *text = *cursor;
    uint32_t value = 0;
    int digits = 0;
    while (*text >= '0' && *text <= '9') {
        digits++;
        if (digits > 10 || value > (UINT32_MAX - (uint32_t)(*text - '0')) / 10u) {
            return 0;
        }
        value = value * 10u + (uint32_t)(*text - '0');
        text++;
    }
    if (digits == 0) {
        return 0;
    }
    *cursor = text;
    *out = value;
    return 1;
}

/** 1.0.2 起确认行可以是 ok p=60 c=1。p 是秒，c=1 表示定时上报只在充电时发。 */
static void apply_ack(const char *line)
{
    const char *cursor = skip_space(line + 2);
    while (*cursor != '\0') {
        uint32_t seconds;
        if (cursor[0] == 'p' && cursor[1] == '=') {
            cursor += 2;
            if (!read_u32(&cursor, &seconds)) {
                return;
            }
            if (seconds < 5u || seconds > 3600u) return;
            clock_set_period(seconds * 1000u);
        } else if (cursor[0] == 'c' && cursor[1] == '=' && (cursor[2] == '0' || cursor[2] == '1')) {
            clock_set_charge_only(cursor[2] == '1');
            cursor += 3;
        } else if (cursor[0] == 'l' && cursor[1] == '=' && (cursor[2] == '0' || cursor[2] == '1')) {
            clock_set_lights(cursor[2] == '1');
            cursor += 3;
        } else if (cursor[0] == 'a' && cursor[1] == '=') {
            cursor += 2;
            if (!read_u32(&cursor, &seconds)) return;
            g_ack_n = seconds;
            g_ack_has = 1;
        } else if ((cursor[0] == 't' || cursor[0] == 'j') && cursor[1] == '=' &&
                   (cursor[2] == '0' || cursor[2] == '1')) {
            radio_option(cursor[0], cursor[2] == '1');
            cursor += 3;
        } else if (cursor[0] == 'v' && cursor[1] == '=') {
            cursor += 2;
            if (!read_u32(&cursor, &seconds)) return;
            clock_set_policy_version(seconds);
        } else {
            return;
        }
        cursor = skip_space(cursor);
    }
}

/**
 * a=<n>：当前队列代号下 q 不大于 n 的记录都已收到。n 超过已发送的范围就截断到 g_sent；
 * 队列头一次推进，只写一次指针，不逐条写 done 标记。
 */
static void ack_upto(uint32_t n)
{
    uint32_t sent = span(g_head, g_sent);
    uint32_t count = 0;
    while (count < sent) {
        uint8_t length;
        uint32_t q;
        if (slot_read((g_head + count) % SLOTS, &length, &q) && !q_covered(q, n)) {
            break;
        }
        count++;
    }
    if (count == 0u) {
        return;
    }
    g_head = (g_head + count) % SLOTS;
    g_wait_ms = clock_ms();
    save_pointers();
}

static int starts_with(const char *line, const char *prefix)
{
    while (*prefix != '\0') {
        if (*line++ != *prefix++) {
            return 0;
        }
    }
    return 1;
}

/** wipe 与 dump 的参数顺序不限；缺参数或多出未知参数都整行丢弃。 */
static int parse_cmd(const char *line, store_cmd_t *cmd)
{
    const char *cursor;
    int wipe = starts_with(line, "wipe ");
    int have_m = 0;
    int have_s = 0;
    int have_f = 0;
    int have_n = 0;
    int have_r = 0;
    int have_q = 0;
    cmd->full = 0;
    cmd->from = cmd->max = cmd->seq = cmd->req = 0;
    cursor = skip_space(line + 5);
    while (*cursor != '\0') {
        if (wipe && cursor[0] == 'm' && cursor[1] == '=' && (cursor[2] == 'q' || cursor[2] == 'f')) {
            cmd->full = cursor[2] == 'f';
            have_m = 1;
            cursor += 3;
        } else if (!wipe && cursor[0] == 'q' && (cursor[1] == ' ' || cursor[1] == '\0')) {
            have_q = 1;
            cursor++;
        } else if (!wipe && cursor[0] == 'f' && cursor[1] == '=') {
            cursor += 2;
            have_f = read_u32(&cursor, &cmd->from);
            if (!have_f) return 0;
        } else if (!wipe && cursor[0] == 'n' && cursor[1] == '=') {
            cursor += 2;
            have_n = read_u32(&cursor, &cmd->max);
            if (!have_n) return 0;
        } else if (!wipe && cursor[0] == 'r' && cursor[1] == '=') {
            cursor += 2;
            have_r = read_u32(&cursor, &cmd->req);
            if (!have_r) return 0;
        } else if (cursor[0] == 's' && cursor[1] == '=') {
            cursor += 2;
            have_s = read_u32(&cursor, &cmd->seq);
            if (!have_s) return 0;
        } else {
            return 0;
        }
        if (*cursor != '\0' && *cursor != ' ') {
            return 0;
        }
        cursor = skip_space(cursor);
    }
    if (!have_s) {
        return 0;
    }
    if (wipe) {
        cmd->kind = STORE_CMD_WIPE;
        return have_m;
    }
    if (have_q && !have_f && !have_n && !have_r) {
        cmd->kind = STORE_CMD_DUMP_INFO;
        return 1;
    }
    cmd->kind = STORE_CMD_DUMP;
    return !have_q && have_f && have_n && have_r;
}

static void take_cmd_line(const char *line)
{
    store_cmd_t cmd;
    if (parse_cmd(line, &cmd) && !g_cmd_ready) {
        g_cmd = cmd;
        g_cmd_ready = 1;
    }
}

static void take_line(const char *line)
{
    if (radio_line(line)) return;
    if (starts_with(line, "wipe ") || starts_with(line, "dump ")) {
        take_cmd_line(line);
        return;
    }
    if (starts_with(line, "net=")) {
        /* 模块链路状态，只在这里记一笔；不是 0/1 的整行丢弃。 */
        if ((line[4] == '0' || line[4] == '1') && line[5] == '\0') {
            clock_note_link(line[4] == '1');
        }
        return;
    }
    if (starts_with(line, "gps=")) {
        /* 模块刚定位成功（任务模板 NOTIFY_STM 打开时才写），马上补一条带坐标的上报。 */
        if (line[4] == '1' && line[5] == '\0') {
            clock_request_report();
        }
        return;
    }
    if (is_ok(line)) {
        /* 1.0.10 起只认 a= 累计确认；没有 a= 的 ok 不再确认任何记录（批量下一个 ok 对应多条）。 */
        g_ack_has = 0;
        apply_ack(line);
        if (g_ack_has) {
            ring_ack(g_ack_n);
            ack_upto(g_ack_n);
        }
        return;
    }
    timebase_on_line(line);
}

static void read_uart(void)
{
    uint8_t byte;
    while (uart_read_byte(BOARD_USART2, &byte)) {
        if (byte == '\n') {
            g_rx[g_rx_len] = '\0';
            take_line(g_rx);
            g_rx_len = 0;
            continue;
        }
        if (byte == '\r') {
            continue;
        }
        if (g_rx_len + 1u >= RX_LINE) {
            g_rx_len = 0;
            continue;
        }
        g_rx[g_rx_len++] = (char)byte;
    }
}

static unsigned put_dec(char *dst, uint32_t value)
{
    char digits[10];
    unsigned count = 0;
    unsigned index;
    do {
        digits[count++] = (char)('0' + (value % 10u));
        value /= 10u;
    } while (value > 0u);
    for (index = 0; index < count; index++) {
        dst[index] = digits[count - 1u - index];
    }
    return count;
}

/**
 * 在行结束符之前追加 q、qe。延迟发送和重试才追加 bf，在线即时首发也可以已经落盘。
 * bf=1 表示这条没能实时送到（离线时记下的，或实时发出后没等到确认）：服务器据此标成「补传」。
 */
static unsigned tag_line(uint8_t *text, unsigned length, uint32_t q, int backfill)
{
    char tag[TAG_MAX];
    unsigned end = length;
    unsigned tag_len = 0;
    unsigned index;
    if (end >= 2u && text[end - 2u] == '\r' && text[end - 1u] == '\n') {
        end -= 2u;
    }
    for (index = 0; index + 4u <= end; index++) {
        if (text[index] == ',' && text[index + 1u] == 'q' && text[index + 2u] == 'z' && text[index + 3u] == '=') {
            end = index;
            break;
        }
    }
    tag[tag_len++] = ',';
    tag[tag_len++] = 'q';
    tag[tag_len++] = '=';
    tag_len += put_dec(tag + tag_len, q);
    tag[tag_len++] = ',';
    tag[tag_len++] = 'q';
    tag[tag_len++] = 'e';
    tag[tag_len++] = '=';
    tag_len += put_dec(tag + tag_len, g_qe);
    if (backfill) {
        tag[tag_len++] = ',';
        tag[tag_len++] = 'b';
        tag[tag_len++] = 'f';
        tag[tag_len++] = '=';
        tag[tag_len++] = '1';
    }
    for (index = length; index > end; index--) {
        text[index - 1u + tag_len] = text[index - 1u];
    }
    for (index = 0; index < tag_len; index++) {
        text[end + index] = (uint8_t)tag[index];
    }
    return length + tag_len;
}

/** 把原始行复制到 out 并追加 q/qe（补传再加 bf）标记，返回长度。 */
static unsigned compose_line(uint8_t *out, const uint8_t *raw, unsigned length, uint32_t q, int backfill)
{
    unsigned index;
    for (index = 0; index < length; index++) {
        out[index] = raw[index];
    }
    return tag_line(out, length, q, backfill);
}

static void write_line(const uint8_t *raw, unsigned length, uint32_t q)
{
    uint8_t text[TEXT_MAX + TAG_MAX + 1u];
    text[compose_line(text, raw, length, q, 0)] = '\0';
    uart_write_text(BOARD_USART2, (char *)text);
}

/** 一批最多 BATCH_MAX 条、BATCH_BYTES 字节，每条以 \r\n 结尾，首尾相接直接写串口。 */
static void send_batch(void)
{
    uint8_t raw[TEXT_MAX];
    uint8_t text[TEXT_MAX + TAG_MAX + 1u];
    unsigned count = 0;
    unsigned total = 0;
    uint32_t now = clock_ms();
    while (count < BATCH_MAX && g_sent != g_tail) {
        uint8_t length = 0;
        uint32_t q = 0;
        unsigned size;
        if (!slot_read(g_sent, &length, &q)) {
            g_sent = (g_sent + 1u) % SLOTS;
            continue;
        }
        gd25_read(slot_addr(g_sent) + 8u, raw, length);
        size = compose_line(text, raw, length, q, 1);
        if (count != 0u && total + size > BATCH_BYTES) {
            break;
        }
        if (g_sent == g_head) {
            g_wait_ms = now;
        }
        text[size] = '\0';
        uart_write_text(BOARD_USART2, (char *)text);
        total += size;
        count++;
        g_sent = (g_sent + 1u) % SLOTS;
    }
    if (count != 0u) {
        g_sent_at = now == 0u ? 1u : now;
    }
}

void store_init(void)
{
    g_rx_len = 0;
    g_sent_at = 0;
    g_wait_ms = 0;
    g_cmd_ready = 0;
    g_link = 0;
    g_ring_head = 0;
    g_ring_n = 0;
    if (!poff_ready()) {
        return;
    }
    load_pointers();
    g_ready = 1;
}

/** 在行结束符之前插入 ,qz=<L>，放不下就不加。 */
static unsigned add_qz(uint8_t *body, unsigned length, uint32_t gap)
{
    char tag[16];
    unsigned tag_len = 0;
    unsigned end = length;
    unsigned index;
    tag[tag_len++] = ',';
    tag[tag_len++] = 'q';
    tag[tag_len++] = 'z';
    tag[tag_len++] = '=';
    tag_len += put_dec(tag + tag_len, gap);
    if (length + tag_len + TAG_MAX > TEXT_MAX) {
        return length;
    }
    if (end >= 2u && body[end - 2u] == '\r' && body[end - 1u] == '\n') {
        end -= 2u;
    }
    for (index = length; index > end; index--) {
        body[index - 1u + tag_len] = body[index - 1u];
    }
    for (index = 0; index < tag_len; index++) {
        body[end + index] = (uint8_t)tag[index];
    }
    return length + tag_len;
}

int store_durable_event(const char *src)
{
    return starts_with(src, "why=pad,") || starts_with(src, "why=shut,");
}

int store_save(const char *src)
{
    uint8_t body[TEXT_MAX];
    unsigned length = 0;
    unsigned index;
    uint32_t q;
    if (!g_ready || !src || src[0] == '\0') {
        store_write_failures++;
        return 0;
    }
    while (src[length] != '\0' && length < TEXT_MAX) {
        body[length] = (uint8_t)src[length];
        length++;
    }
    /*
     * 记录文本里直接带 qz，这样不管留在 RAM 环里还是落到 Flash，发出去的行都一样，
     * 不需要再记“这条要补 qz”的状态；发送时 q/qe 插在它前面，顺序是 q、qe、qz。
     */
    if (g_gap_valid) {
        length = add_qz(body, length, g_gap_l);
    }
    if (!reserve_q()) { store_write_failures++; return 0; }
    q = g_qnext;
    if (!store_durable_event(src) && g_link && queued() == 0u && g_ring_n < RING_N) {
        /* 联网且没有积压：不写 Flash，先放进在途环并立刻发出。 */
        flight_t *entry = &g_ring[(g_ring_head + g_ring_n) % RING_N];
        uint32_t now = clock_ms();
        entry->q = q;
        entry->length = (uint8_t)length;
        entry->at = now == 0u ? 1u : now;
        for (index = 0; index < length; index++) {
            entry->text[index] = body[index];
        }
        g_ring_n++;
        g_qnext++;
        g_gap_valid=0;
        write_line(entry->text, length, q);
        g_sent_at = entry->at;
        return 1;
    }
    /* 有积压或环满：先让环里的落盘，保证顺序，新的排在后面。 */
    if (g_ring_n != 0u && !ring_spill()) {
        store_write_failures++;
        return 0;
    }
    const uint32_t slot = g_tail;
    /* Older slots can already be on the server while waiting for a cumulative ACK. */
    const int send_live = g_link && g_sent == slot;
    if (flash_put(q, body, length, 1)) {
        g_qnext++; g_gap_valid=0;
        if (send_live && g_tail == (slot + 1u) % SLOTS && g_sent == slot) {
            const uint32_t now = clock_ms();
            if (g_sent == g_head) g_wait_ms = now;
            write_line(body, length, q);
            g_sent = g_tail;
            g_sent_at = now == 0u ? 1u : now;
        }
        return 1;
    }
    store_write_failures++;
    return 0;
}

void store_poll(int link_up)
{
    read_uart();
    if (!g_ready) {
        return;
    }
    g_link = link_up ? 1u : 0u;
    /* 以下判断都只在主循环转一圈时顺带做，用 clock_ms 惰性比较，不设定时器。 */
    if (g_ring_n != 0u && (!link_up || (clock_ms() - g_ring[g_ring_head].at) >= ACK_WAIT_MS)) {
        ring_spill();
    }
    if (!link_up) {
        return;
    }
    if (g_sent != g_head && (clock_ms() - g_wait_ms) >= RESEND_MS) {
        g_sent = g_head;
        g_wait_ms = clock_ms();
    }
    if (g_sent_at != 0u && (clock_ms() - g_sent_at) < SEND_GAP_MS) {
        return;
    }
    send_batch();
}

int store_take_cmd(store_cmd_t *cmd)
{
    if (!g_cmd_ready) {
        return 0;
    }
    *cmd = g_cmd;
    g_cmd_ready = 0;
    return 1;
}

int store_stream_ready(void)
{
    if (!g_ready || queued() != 0u || g_ring_n != 0u) {
        return 0;
    }
    return g_sent_at == 0u || (clock_ms() - g_sent_at) >= SEND_GAP_MS;
}

void store_stream(const char *text)
{
    uint32_t now = clock_ms();
    uart_write_text(BOARD_USART2, text);
    g_sent_at = now == 0u ? 1u : now;
}

/* 在线且还有补传没发出去（每批隔 1 秒）：这时不进 Stop，免得每批多等一秒。 */
int store_sending(void)
{
    return g_ready && g_link && g_sent != g_tail;
}

uint32_t store_pending(void)
{
    if (!g_ready) {
        return 0;
    }
    return queued() + g_ring_n;
}

int store_available(void) { return g_ready != 0; }

uint32_t store_free(void)
{
    if (!g_ready) {
        return 0;
    }
    return (SLOTS - queued()) * SLOT;
}

/** 只重置索引和首扇区，旧数据扇区循环使用时再擦，掉电日志保持不动。 */
int store_factory_reset(void)
{
    if (!g_ready || poff_power_low()) return 0;
    if (!gd25_erase_sector(DATA_BASE) || !gd25_erase_sector(STORE_BASE)) return 0;
    g_head = g_tail = g_sent = g_ptr = g_sent_at = g_wait_ms = 0;
    g_qnext = g_qlimit = 0;
    g_qbits = Q_FORMAT;
    g_active_ptr = POINTER_BYTES;
    g_gap_valid = 0;
    g_ring_head = g_ring_n = 0;
    g_qe++;
    g_rx_len = 0;
    g_cmd_ready = 0;
    g_recover_tail = 0; /* 防止空队列边界的旧槽被重启恢复逻辑重新捞出。 */
    return save_pointers();
}

/*
 * 本地读取（USB 串口）用：第 index 条还没同步到服务器的记录，先 Flash 队列（从最老的开始）再在途环。
 * 原文复制到 out（去掉行尾回车换行），返回 1；没有这一条返回 0。
 * in_flash 为 1 表示已经落盘；在线即时首发也可能已落盘。槽坏了读不出时 out 为空、q 为 0。
 */
int store_peek(uint32_t index, char *out, unsigned cap, uint32_t *q, int *in_flash)
{
    uint8_t raw[TEXT_MAX];
    uint8_t length = 0;
    unsigned n = 0;
    unsigned i;
    if (!g_ready || cap == 0u) {
        return 0;
    }
    if (index < queued()) {
        uint32_t slot = (g_head + index) % SLOTS;
        *in_flash = 1;
        if (!slot_read(slot, &length, q)) {
            *q = 0;
            out[0] = '\0';
            return 1;
        }
        gd25_read(slot_addr(slot) + 8u, raw, length);
    } else {
        const flight_t *entry;
        index -= queued();
        if (index >= g_ring_n) {
            return 0;
        }
        entry = &g_ring[(g_ring_head + index) % RING_N];
        *in_flash = 0;
        *q = entry->q;
        length = entry->length;
        for (i = 0; i < length; i++) {
            raw[i] = entry->text[i];
        }
    }
    for (i = 0; i < length && n + 1u < cap; i++) {
        if (raw[i] != '\r' && raw[i] != '\n') {
            out[n++] = (char)raw[i];
        }
    }
    out[n] = '\0';
    return 1;
}

/* 本地读取用：Flash 里待补传的条数、在途环里的条数、下一个要分配的 q、队列代号。 */
void store_stats(uint32_t *flash, uint32_t *ring, uint32_t *next_q, uint32_t *epoch)
{
    *flash = g_ready ? queued() : 0u;
    *ring = g_ready ? g_ring_n : 0u;
    *next_q = g_qnext;
    *epoch = g_qe;
}
