#include "battery.h"
#include "board.h"
#include "clock.h"
#include "console.h"
#include "poff.h"
#include "store.h"
#include "timebase.h"
#include "uart.h"

#define CMD_MAX 16u
#define OUT_MAX 300u

static char g_cmd[CMD_MAX];
static uint8_t g_cmd_len;
static uint8_t g_cmd_long;
/* dump 进行中：下一条要吐的下标；不在 dump 时为 0 且 g_dumping 为 0。 */
static uint8_t g_dumping;
static uint32_t g_dump_index;

void console_init(void)
{
    uart_bind(BOARD_USART1, BOARD_PORT_A, BOARD_PIN_USART1_TX, BOARD_PORT_A, BOARD_PIN_USART1_RX);
    g_cmd_len = 0;
    g_cmd_long = 0;
    g_dumping = 0;
    g_dump_index = 0;
}

void console_write(const char *text)
{
    uart_write_text(BOARD_USART1, text);
}

/* ---- 拼一行回复：没有 printf，自己写数字。 ---- */

typedef struct {
    char text[OUT_MAX];
    unsigned n;
} out_t;

static void put(out_t *out, const char *text)
{
    while (*text != '\0' && out->n + 3u < OUT_MAX) {
        out->text[out->n++] = *text++;
    }
}

static void put_u64(out_t *out, uint64_t value)
{
    char digits[21];
    unsigned n = 0;
    do {
        digits[n++] = (char)('0' + (unsigned)(value % 10u));
        value /= 10u;
    } while (value != 0u && n < sizeof digits);
    while (n != 0u && out->n + 3u < OUT_MAX) {
        out->text[out->n++] = digits[--n];
    }
}

static void put_int(out_t *out, int value)
{
    if (value < 0) {
        put(out, "-");
        put_u64(out, (uint64_t)(-(int64_t)value));
    } else {
        put_u64(out, (uint64_t)value);
    }
}

static void field(out_t *out, const char *key, uint64_t value)
{
    put(out, " ");
    put(out, key);
    put(out, "=");
    put_u64(out, value);
}

static void send(out_t *out)
{
    out->text[out->n++] = '\r';
    out->text[out->n++] = '\n';
    out->text[out->n] = '\0';
    console_write(out->text);
    out->n = 0;
}

static int same(const char *a, const char *b)
{
    while (*a != '\0' && *b != '\0') {
        char x = *a >= 'A' && *a <= 'Z' ? (char)(*a - 'A' + 'a') : *a;
        if (x != *b) {
            return 0;
        }
        a++;
        b++;
    }
    return *a == '\0' && *b == '\0';
}

static void answer(const char *cmd, const console_state_t *state)
{
    out_t out;
    uint32_t flash, ring, next_q, epoch;
    out.n = 0;
    if (same(cmd, "help") || same(cmd, "?")) {
        put(&out, "#help info queue dump last");
        send(&out);
        return;
    }
    if (same(cmd, "info")) {
        put(&out, "#info fw=" BOARD_FIRMWARE);
        field(&out, "seq", state->seq);
        field(&out, "opens", state->opens);
        field(&out, "lid", state->lid_open ? 1u : 0u);
        field(&out, "chg", (uint64_t)(state->charge < 0 ? 0 : state->charge));
        put(&out, " bat=");
        put_int(&out, state->battery_mv);
        field(&out, "link", state->ready ? 1u : 0u);
        field(&out, "t", timebase_synced() ? timebase_now() : 0u);
        field(&out, "period", clock_period_seconds());
        field(&out, "pending", store_pending());
        field(&out, "free", poff_ready() ? (uint64_t)poff_free() + store_free() : 0u);
        field(&out, "vdda", battery_vdda_mv);
        field(&out, "badref", battery_bad_ref);
        send(&out);
        return;
    }
    if (same(cmd, "queue")) {
        store_stats(&flash, &ring, &next_q, &epoch);
        put(&out, "#queue");
        field(&out, "pending", flash + ring);
        field(&out, "flash", flash);
        field(&out, "ring", ring);
        field(&out, "writeerr", store_write_failures);
        field(&out, "full", store_overflows);
        field(&out, "next", next_q);
        field(&out, "qe", epoch);
        send(&out);
        return;
    }
    if (same(cmd, "dump")) {
        g_dumping = 1;
        g_dump_index = 0;
        return;
    }
    if (same(cmd, "last")) {
        put(&out, "#last ");
        put(&out, state->last_line ? state->last_line : "");
        /* 上报行自带回车换行，去掉再统一加 */
        while (out.n != 0u && (out.text[out.n - 1u] == '\r' || out.text[out.n - 1u] == '\n')) {
            out.n--;
        }
        send(&out);
        return;
    }
    put(&out, "#err cmd=");
    put(&out, cmd);
    send(&out);
}

/* dump：每圈吐一条，吐完发 #end。 */
static void dump_step(void)
{
    out_t out;
    char line[OUT_MAX - 48u];
    uint32_t q = 0;
    int in_flash = 0;
    out.n = 0;
    if (!store_peek(g_dump_index, line, sizeof line, &q, &in_flash)) {
        put(&out, "#end");
        field(&out, "n", g_dump_index);
        send(&out);
        g_dumping = 0;
        g_dump_index = 0;
        return;
    }
    put(&out, "#rec");
    field(&out, "i", g_dump_index);
    field(&out, "q", q);
    field(&out, "bf", in_flash ? 1u : 0u);
    put(&out, " ");
    put(&out, line);
    send(&out);
    g_dump_index++;
}

void console_poll(const console_state_t *state)
{
    uint8_t byte;
    /* 一圈最多处理这么多字节，命令行很短 */
    unsigned budget = 64u;
    while (budget-- != 0u && uart_read_byte(BOARD_USART1, &byte)) {
        if (byte == '\r' || byte == '\n') {
            if (g_cmd_len != 0u && !g_cmd_long) {
                g_cmd[g_cmd_len] = '\0';
                answer(g_cmd, state);
            }
            g_cmd_len = 0;
            g_cmd_long = 0;
            continue;
        }
        /* 只收可见字符；超长的整行丢掉，避免拿半截命令去执行 */
        if (byte < 0x20u || byte > 0x7Eu) {
            continue;
        }
        if (g_cmd_len + 1u < CMD_MAX) {
            g_cmd[g_cmd_len++] = (char)byte;
        } else {
            g_cmd_long = 1;
        }
    }
    if (g_dumping) {
        dump_step();
    }
}

int console_busy(void)
{
    return g_dumping != 0u;
}
