#include "board.h"
#include "clock.h"
#include "factory_reset.h"

#define SYST_CSR (*(volatile uint32_t *)0xE000E010u)
#define SYST_RVR (*(volatile uint32_t *)0xE000E014u)
#define SYST_CVR (*(volatile uint32_t *)0xE000E018u)
#define SCB_SHPR3 (*(volatile uint32_t *)0xE000ED20u)

static volatile uint32_t g_ms;
static uint32_t g_mark;
static uint32_t g_period;
static uint8_t g_charge_only;
static uint8_t g_link_seen;
static uint8_t g_link_up;
static uint32_t g_link_ms;
static uint8_t g_lights_off; /* 取反存放，零初始化即为亮 */
static uint32_t g_policy_version;
static uint32_t g_battery_mark;
static uint32_t g_request_ms;
static uint8_t g_requested;
/*
 * 计时来源：LSE 起来之前用 SysTick（MSI，误差约 1%，开机几小时就能差出一分钟）；
 * 起来以后按 LPTIM1 的 1024 Hz 计数走，Stop 里 SysTick 停了也照样算，醒来一次补上。
 */
static uint32_t (*g_ticks)(void);
static uint32_t g_tick_last;
static uint32_t g_tick_frac;
static uint8_t g_tick_still;
static uint8_t g_ticks_lost;
static uint8_t g_power;
static lid_t *g_lid;
static charger_t *g_charger;
static event_queue_t *g_events;

void clock_start(lid_t *lid, charger_t *charger, event_queue_t *events, uint32_t period_ms)
{
    g_lid = lid;
    g_charger = charger;
    g_events = events;
    g_period = period_ms;
    g_ms = 0;
    g_mark = 0;
    g_charge_only = 0;
    g_lights_off = 0;
    g_link_seen = 0;
    g_link_up = 0;
    g_policy_version = 0;
    g_battery_mark = 0;
    g_request_ms = 0;
    g_requested = 0;
    g_ticks = 0;
    g_tick_last = 0;
    g_tick_frac = 0;
    g_tick_still = 0;
    g_ticks_lost = 0;
    #ifndef HOST_TEST
    SYST_RVR = (BOARD_MSI_HZ / BOARD_SYSTICK_HZ) - 1u;
    SYST_CVR = 0;
    /* SysTick 降到最低优先级，USART2 接收中断（最高）才能打断它，否则波特率高时会 ORE。 */
    SCB_SHPR3 |= 0xC0000000u;
    SYST_CSR = 7u;
    #endif
}

uint32_t clock_ms(void)
{
    return g_ms;
}

void clock_set_period(uint32_t period_ms)
{
    if (period_ms < 5000u || period_ms > 3600000u || period_ms == g_period) {
        return;
    }
    g_period = period_ms;
    g_mark = g_ms;
}

void clock_set_charge_only(int enabled)
{
    g_charge_only = enabled ? 1u : 0u;
}

/* 时间往前走 ms 毫秒，到了上报周期就投递 EVENT_TIMER。Stop 醒来时一次会走几百毫秒。 */
static void advance(uint32_t ms)
{
    g_ms += ms;
    if (g_period == 0u || (g_ms - g_mark) < g_period) {
        return;
    }
    g_mark += g_period;
    if ((g_ms - g_mark) >= g_period) {
        /* 睡过了不止一个周期（定时叫醒没响）：只补一次，从现在重新算 */
        g_mark = g_ms;
    }
    if (g_charge_only && charger_status() == 0) {
        /* 用电池：长周期报一次，不再整段停报 */
        if ((g_ms - g_battery_mark) < CLOCK_BATTERY_PERIOD_MS) {
            return;
        }
    }
    g_battery_mark = g_ms;
    event_post(g_events, EVENT_TIMER);
}

static void follow(void)
{
    uint32_t now = g_ticks() & 0xFFFFu;
    uint32_t delta = (now - g_tick_last) & 0xFFFFu;
    if (delta == 0u) {
        /* LPTIM 每毫秒约走 1 格。连着 50 个节拍都不动，说明 32.768k 晶振停了：退回 SysTick */
        if (++g_tick_still >= 50u) {
            g_ticks = 0;
            g_ticks_lost = 1u;
        }
        return;
    }
    g_tick_still = 0u;
    g_tick_last = now;
    /* 1024 格 = 1000 毫秒，余数留到下次，长期不累积误差 */
    g_tick_frac += delta * 1000u;
    advance(g_tick_frac >> 10);
    g_tick_frac &= 1023u;
}

void SysTick_Handler(void)
{
    if (g_ticks) {
        follow();
    } else {
        advance(1u);
    }
    factory_reset_on_ms();
    if (g_lid) {
        lid_on_ms(g_lid);
    }
    if (g_charger) {
        charger_on_ms(g_charger);
    }
}

void clock_follow_ticks(uint32_t (*read)(void))
{
    if (!read) {
        g_ticks = 0;
        return;
    }
    g_tick_last = read() & 0xFFFFu;
    g_tick_frac = 0u;
    g_tick_still = 0u;
    g_ticks_lost = 0u;
    g_ticks = read;
}

int clock_ticks_lost(void) { return g_ticks_lost != 0u; }
void clock_note_power(int level) { g_power = (uint8_t)level; }
int clock_power_level(void) { return g_power; }

uint32_t clock_period_seconds(void) { return g_period / 1000u; }
/* Return the actual battery-mode deadline, on the same grid as advance(). */
uint32_t clock_next_report_ms(void)
{
    uint32_t due = g_mark + g_period;
    if (g_period && g_charge_only && charger_status() == 0) {
        int32_t gap = (int32_t)(g_battery_mark + CLOCK_BATTERY_PERIOD_MS - due);
        if (gap > 0) due += (((uint32_t)gap + g_period - 1u) / g_period) * g_period;
    }
    return due;
}
void clock_reset_policy(void)
{
    g_period = BOARD_REPORT_PERIOD_MS;
    g_charge_only = 0;
    g_lights_off = 0;
    g_policy_version = 0;
    g_mark = g_ms;
}
uint32_t clock_policy_version(void) { return g_policy_version; }
int clock_charge_only(void) { return g_charge_only != 0u; }
void clock_set_lights(int on) { g_lights_off = on ? 0u : 1u; }
int clock_lights_on(void) { return g_lights_off == 0u; }
void clock_note_link(int up)
{
    g_link_up = up ? 1u : 0u;
    g_link_ms = g_ms;
    g_link_seen = 1;
}
int clock_link_seen(void) { return g_link_seen != 0u; }
int clock_link_online(void) { return g_link_up != 0u && (g_ms - g_link_ms) < CLOCK_LINK_STALE_MS; }
void clock_request_report(void)
{
    if (!g_events) return;
    if (g_requested && (g_ms - g_request_ms) < CLOCK_REQUEST_GAP_MS) return;
    g_requested = 1;
    g_request_ms = g_ms;
    event_post(g_events, EVENT_TIMER);
}

/** 新版本只确认一次，即使切换为仅充电模式，也立即回报实际配置。 */
void clock_set_policy_version(uint32_t version)
{
    if (g_policy_version == version) return;
    g_policy_version = version;
    if (g_events) event_post(g_events, EVENT_TIMER);
}
