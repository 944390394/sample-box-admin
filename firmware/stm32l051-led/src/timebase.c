#include "clock.h"
#include "timebase.h"

static uint64_t g_origin;
static uint32_t g_clock;
static uint8_t g_synced;

static int parse_ntp(const char *line, uint64_t *millis)
{
    uint64_t value = 0;
    int digits = 0;
    const char *cursor = line;
    if (cursor[0] != 'n' || cursor[1] != 't' || cursor[2] != 'p' || cursor[3] != '=') {
        return 0;
    }
    cursor += 4;
    while (*cursor >= '0' && *cursor <= '9') {
        digits++;
        if (digits > 13) {
            return 0;
        }
        value = value * 10u + (uint64_t)(*cursor - '0');
        cursor++;
    }
    /* 模块把 os.time() 的秒补成 13 位毫秒。短于这个数量的不是这次对时。 */
    if (*cursor != '\0' || value < 1000000000000ull) {
        return 0;
    }
    *millis = value;
    return 1;
}

static void accept_line(const char *line)
{
    uint64_t millis;
    uint32_t now;
    if (g_synced || !parse_ntp(line, &millis)) {
        return;
    }
    now = clock_ms();
    g_origin = millis;
    g_clock = now;
    g_synced = 1;
}

void timebase_on_line(const char *line)
{
    accept_line(line);
}

int timebase_synced(void)
{
    return g_synced;
}

uint64_t timebase_now(void)
{
    uint32_t elapsed = clock_ms() - g_clock;
    return g_origin + elapsed;
}
