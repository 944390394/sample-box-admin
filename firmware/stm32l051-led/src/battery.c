#include "battery.h"
#include "board.h"
#include "clock.h"
#include "gpio.h"

/*
 * STM32L0 的 ADC 时钟默认来自 HSI16，而 HSI16 复位后是关的。
 * CKMODE 选 PCLK，才能在只开 MSI 时完成转换。
 */
#define ADC_BASE 0x40012400u
#define ADC_ISR (*(volatile uint32_t *)(ADC_BASE + 0x00u))
#define ADC_CR (*(volatile uint32_t *)(ADC_BASE + 0x08u))
#define ADC_CFGR1 (*(volatile uint32_t *)(ADC_BASE + 0x0Cu))
#define ADC_AUTOFF (1u << 15)
#define ADC_CFGR2 (*(volatile uint32_t *)(ADC_BASE + 0x10u))
#define ADC_SMPR (*(volatile uint32_t *)(ADC_BASE + 0x14u))
#define ADC_CHSELR (*(volatile uint32_t *)(ADC_BASE + 0x28u))
#define ADC_DR (*(volatile uint32_t *)(ADC_BASE + 0x40u))
#define ADC_CCR (*(volatile uint32_t *)(ADC_BASE + 0x308u))
/* 出厂在 VDDA=3.0 V 下测得的内部基准读数，用它反推实际 VDDA；板子直接用电池供 VDDA 时也准。 */
#define VREFINT_CAL (*(volatile uint16_t *)0x1FF80078u)
#define VREFINT_CHANNEL 17u
#define ADC_VREFEN (1u << 22)
#define VREFINT_CAL_MV 3000u
#define RCC_APB2ENR (*(volatile uint32_t *)0x40021034u)

#define ADC_ADRDY (1u << 0)
#define ADC_EOC (1u << 2)
#define ADC_ADSTART (1u << 2)
#define ADC_ADEN (1u << 0)
#define ADC_ADCAL (1u << 31)

static int g_ready;
/* 最近一次安静时测到的电压和时刻；上报时直接用，避开模块发射时电压被拉低。 */
static int g_mv;
static uint32_t g_at;
static int g_have;
uint32_t battery_bad_ref;
uint32_t battery_vdda_mv;

static int wait_clear(volatile uint32_t *reg, uint32_t mask)
{
    uint32_t guard = 100000u;
    while ((*reg & mask) != 0u) {
        if (guard-- == 0u) {
            return 0;
        }
    }
    return 1;
}

static int wait_set(volatile uint32_t *reg, uint32_t mask)
{
    uint32_t guard = 100000u;
    while ((*reg & mask) == 0u) {
        if (guard-- == 0u) {
            return 0;
        }
    }
    return 1;
}

void battery_init(void)
{
    g_ready = 0;
    gpio_set_analog(BOARD_PORT_A, BOARD_PIN_BATTERY);
    RCC_APB2ENR |= 1u << 9;
    ADC_CFGR2 = 3u << 30;
    ADC_CR |= ADC_ADCAL;
    if (!wait_clear(&ADC_CR, ADC_ADCAL)) {
        return;
    }
    ADC_ISR = ADC_ADRDY;
    ADC_CR |= ADC_ADEN;
    if (!wait_set(&ADC_ISR, ADC_ADRDY)) {
        return;
    }
    ADC_SMPR = 7u;
    /* 自动关断：只在转换时给 ADC 上电，平时（包括 Stop 里）不耗电；开始转换时硬件自己等它稳定 */
    ADC_CFGR1 |= ADC_AUTOFF;
    g_ready = 1;
}

static int read_channel(uint32_t channel, uint32_t *raw)
{
    ADC_CHSELR = 1u << channel;
    ADC_CR |= ADC_ADSTART;
    if (!wait_set(&ADC_ISR, ADC_EOC)) {
        return 0;
    }
    *raw = ADC_DR & 0x0FFFu;
    return 1;
}

/** 测一次：基准 4 次、电池 8 次取平均，按 VREFINT 校准 VDDA。基准缓冲只在测量期间打开。 */
static int measure(void)
{
    uint32_t vref = 0, bat = 0, raw, vdda = BOARD_VDDA_MV, cal;
    unsigned i;
    volatile uint32_t settle;
    if (!g_ready) {
        return 0;
    }
    ADC_CCR |= ADC_VREFEN;
    for (settle = 0; settle < 2000u; settle++) {
    }
    for (i = 0; i < 8u; i++) {
        if (i < 4u) {
            if (!read_channel(VREFINT_CHANNEL, &raw)) break;
            vref += raw;
        }
        if (!read_channel(BOARD_PIN_BATTERY, &raw)) break;
        bat += raw;
    }
    ADC_CCR &= ~ADC_VREFEN;
    if (i < 8u) {
        return 0;
    }
    cal = VREFINT_CAL;
    /* 芯片没有出厂校准值（读出 0 或全 1）时只能按板上 LDO 的 3.3 V 算。 */
    if (vref != 0u && cal != 0u && cal != 0xFFFFu) {
        uint32_t v = (VREFINT_CAL_MV * cal * 4u + vref / 2u) / vref;
        battery_vdda_mv = v;
        /*
         * 算出的 VDDA 不在 1.8–3.6 V：基准没稳，或者 VDDA 真被外部抬高了
         * （例如接着 ST-Link 的 3.3 V 线时抬到约 4.8 V）。这时按 3.3 V 硬算会得到一个看起来正常、
         * 其实偏低很多的电压（2026-11-10 实测把 4.1 V 报成 2.86 V），所以这次读数作废：
         * 返回 0，沿用上一次的有效值。上报里 bat=0 服务器会忽略，充电判断、指示灯、电量学习也都跳过 0。
         */
        if (v < 1800u || v > 3600u) {
            battery_bad_ref++;
            return 0;
        }
        vdda = v;
    }
    return (int)(((bat / 8u) * (vdda * BOARD_BATTERY_RATIO) + 2047u) / 4095u);
}

static void remember(int mv)
{
    if (mv <= 0) return;
    g_mv = mv;
    g_at = clock_ms();
    g_have = 1;
}

void battery_poll(int quiet)
{
    if (!quiet || !g_ready) return;
    if (g_have && (clock_ms() - g_at) < BATTERY_SAMPLE_MS) return;
    remember(measure());
}

int battery_millivolts(void)
{
    if (g_have && (clock_ms() - g_at) < BATTERY_FRESH_MS) {
        return g_mv;
    }
    remember(measure());
    return g_have ? g_mv : 0;
}
