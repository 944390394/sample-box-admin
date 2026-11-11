#include "board.h"
#include "clock.h"
#include "radio.h"
#include "curve.h"
#include "factory_reset.h"
#include "factory_state.h"
#include "gd25.h"
#include "gpio.h"
#include "poff.h"
#include "store.h"

/* 曲线 85*48 字节后剩余 16 字节；标记使清理中断电后可继续完成。 */
#define RESET_MARK (GD25_CURVE_BASE + GD25_SECTOR - 16u)
static volatile factory_state_t g_state;
static led_t *g_led;
static uint8_t g_step;
static uint8_t g_pending;
/* 抹除模式：0 只恢复出厂，1 快速擦日志，2 完整擦日志。标记第 2 字节为 0 表示抹除，续做时一律完整。 */
static uint8_t g_wipe;
static volatile uint8_t g_start;
static uint32_t g_sector;

void factory_reset_init(led_t *led)
{
    uint8_t mark[2] = {0xFFu, 0xFFu};
    factory_state_t state;
    gpio_set_input(BOARD_PORT_B, BOARD_PIN_FACTORY, GPIO_PULL_UP);
    factory_state_init(&state);
    if (poff_ready()) gd25_read(RESET_MARK, mark, 2u);
    g_pending = mark[0] != 0xFFu;
    g_wipe = g_pending && mark[1] == 0u ? 2u : 0u;
    g_start = 0;
    g_sector = 0;
    if (g_pending) state.phase = FACTORY_RUN;
    g_state = state;
    g_step = 0;
    g_led = led;
}

void factory_reset_on_ms(void)
{
    factory_state_t state;
    if (!g_led) return;
    state = g_state;
    if (g_start) {
        g_start = 0;
        if (state.phase != FACTORY_RUN) {
            state.phase = FACTORY_RUN; state.elapsed = 0; state.armed = 0;
        }
    }
    factory_state_tick(&state, !gpio_read(BOARD_PORT_B, BOARD_PIN_FACTORY));
    g_state = state;
    led_override(g_led, factory_state_lights(&state));
}

int factory_reset_idle(void)
{
    return g_led && !g_start && !g_pending && g_state.phase == FACTORY_IDLE && gpio_read(BOARD_PORT_B, BOARD_PIN_FACTORY);
}

int factory_reset_wipe(int full)
{
    if (!g_led || g_start || g_state.phase == FACTORY_RUN) return 0;
    g_wipe = full ? 2u : 1u;
    g_step = 0;
    g_sector = 0;
    g_start = 1;
    return 1;
}

static void failed(void)
{
    g_state.phase = FACTORY_ERROR;
    g_state.armed = 0;
    g_step = 0;
    g_sector = 0;
}

int factory_reset_poll(void)
{
    uint8_t mark[2];
    if (g_state.phase != FACTORY_RUN) return g_pending || g_state.phase == FACTORY_ERROR || g_start;
    g_pending = 1;
    if (!poff_ready() || poff_power_low()) { failed(); return 1; }
    if (g_step == 0) {
        mark[0] = 0u;
        mark[1] = g_wipe ? 0u : 0xFFu;
        if (!gd25_page_program(RESET_MARK, mark, 2u)) { failed(); return 1; }
        gd25_read(RESET_MARK, mark, 2u);
        if (mark[0] != 0u || (g_wipe && mark[1] != 0u)) { failed(); return 1; }
    } else if (g_step == 1) {
        if (!store_factory_reset()) { failed(); return 1; }
    } else if (g_step == 2) {
        /* 抹除时整个日志区随后清掉，不必再往里写一条。 */
        if (!g_wipe && !poff_note_opens(0u)) { failed(); return 1; }
    } else if (g_step == 3) {
        /* 标记在曲线扇区，日志区先擦完才进入下一步，所以任何时刻断电都能续做。 */
        int done = g_wipe ? poff_erase_log(&g_sector, g_wipe == 2u) : 1;
        if (done < 0) { failed(); return 1; }
        if (done == 0) return 1;
    } else if (g_step == 4) {
        /* 最后清曲线同时移除恢复标记，前面任一步失败都不能宣告完成。 */
        if (!curve_factory_reset()) { failed(); return 1; }
        radio_reset();
        clock_reset_policy();
    } else {
        if (g_state.elapsed < 750u) return 1;
        #ifdef HOST_TEST
        extern void factory_test_reboot(void);
        factory_test_reboot();
        return 1;
        #else
        __asm volatile("dsb" ::: "memory");
        *(volatile uint32_t *)0xE000ED0Cu = 0x05FA0004u;
        __asm volatile("dsb" ::: "memory");
        for (;;) {}
        #endif
    }
    g_step++;
    return 1;
}
