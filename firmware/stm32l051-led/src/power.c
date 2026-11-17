#include "board.h"
#include "clock.h"
#include "gd25.h"
#include "power.h"
#include "uart.h"

#define RCC_APB2ENR (*(volatile uint32_t *)0x40021034u)
#define RCC_APB1ENR (*(volatile uint32_t *)0x40021038u)
#define RCC_CCIPR (*(volatile uint32_t *)0x4002104Cu)
#define RCC_CSR (*(volatile uint32_t *)0x40021050u)
#define PWR_CR (*(volatile uint32_t *)0x40007000u)
#define SYSCFG_EXTICR2 (*(volatile uint32_t *)0x4001000Cu)
#define SYSCFG_EXTICR3 (*(volatile uint32_t *)0x40010010u)
#define EXTI_IMR (*(volatile uint32_t *)0x40010400u)
#define EXTI_RTSR (*(volatile uint32_t *)0x40010408u)
#define EXTI_FTSR (*(volatile uint32_t *)0x4001040Cu)
#define EXTI_PR (*(volatile uint32_t *)0x40010414u)
#define LPTIM_ISR (*(volatile uint32_t *)0x40007C00u)
#define LPTIM_ICR (*(volatile uint32_t *)0x40007C04u)
#define LPTIM_IER (*(volatile uint32_t *)0x40007C08u)
#define LPTIM_CFGR (*(volatile uint32_t *)0x40007C0Cu)
#define LPTIM_CR (*(volatile uint32_t *)0x40007C10u)
#define LPTIM_CMP (*(volatile uint32_t *)0x40007C14u)
#define LPTIM_ARR (*(volatile uint32_t *)0x40007C18u)
#define LPTIM_CNT (*(volatile uint32_t *)0x40007C1Cu)
#define SCB_ICSR (*(volatile uint32_t *)0xE000ED04u)
#define SCB_SCR (*(volatile uint32_t *)0xE000ED10u)
#define NVIC_ISER (*(volatile uint32_t *)0xE000E100u)
#define NVIC_IPR(irq) (*(volatile uint32_t *)(0xE000E400u + 4u * ((irq) / 4u)))

#define IRQ_PVD 1u
#define IRQ_EXTI4_15 7u
#define IRQ_LPTIM1 13u

#define LSE_ON (1u << 8)
#define LSE_RDY (1u << 9)
#define LSE_DRV (3u << 11)
#define LSE_DRV_MEDIUM_HIGH (2u << 11)
#define PWR_LPSDSR (1u << 0)
#define PWR_PDDS (1u << 1)
#define PWR_CWUF (1u << 2)
#define PWR_DBP (1u << 8)
#define SCB_SLEEPDEEP (1u << 2)
#define SCB_PENDSTSET (1u << 26)

#define LPTIM_CMPM (1u << 0)
#define LPTIM_ARRM (1u << 1)
#define LPTIM_CMPOK (1u << 3)
#define LPTIM_ARROK (1u << 4)
#define LPTIM_ENABLE (1u << 0)
#define LPTIM_CNTSTRT (1u << 2)
#define LPTIM_TICKS_PER_S 1024u

/* 叫醒单片机的引脚：按键 PB5、充电 PB8/PB9、箱盖 PB10，上升下降沿都算。 */
#define LINE_PINS ((1u << BOARD_PIN_FACTORY) | (1u << BOARD_PIN_CHRG) | (1u << BOARD_PIN_STDBY) | (1u << BOARD_PIN_LID))
#define LINE_PVD (1u << 16)
#define LINE_USART2 (1u << 26)
#define LINE_LPTIM1 (1u << 29)

/* 开机后 LSE 等这么久还没起来，就不用 Stop 了。 */
#define LSE_TIMEOUT_MS 5000u
/* 串口最后一个字节之后再醒着这么久：一行话中间不睡。 */
#define RX_LINGER_MS 10u

volatile uint32_t power_stops;
volatile uint32_t power_lse;

#if BOARD_LOW_POWER >= 2u
static uint8_t g_stop_ready;
static uint32_t g_rx_seen;
static uint32_t g_rx_at;

static void irq_enable(uint32_t irq)
{
    /* M0+ 只能按字访问优先级寄存器；这几个中断都只是清标志，排在串口接收（最高）之后。 */
    uint32_t shift = (irq % 4u) * 8u;
    NVIC_IPR(irq) = (NVIC_IPR(irq) & ~(0xFFu << shift)) | (0x80u << shift);
    NVIC_ISER = 1u << irq;
}

/* LPTIM 用 LSE 计数，和总线时钟不同步：连读两次一样才算数。 */
static uint32_t lptim_count(void)
{
    uint32_t a;
    uint32_t b;
    uint32_t guard = 8u;
    do {
        a = LPTIM_CNT;
        b = LPTIM_CNT;
    } while (a != b && --guard != 0u);
    return a & 0xFFFFu;
}

/* 写 ARR、CMP 后要等同步到 LSE 时钟域（两三个 LSE 周期，约 100 µs）。 */
static int lptim_wait(uint32_t flag)
{
    uint32_t guard = 20000u;
    while ((LPTIM_ISR & flag) == 0u) {
        if (--guard == 0u) {
            return 0;
        }
    }
    return 1;
}

static int lptim_start(void)
{
    RCC_CCIPR = (RCC_CCIPR & ~(3u << 18)) | (3u << 18); /* LPTIM1 时钟选 LSE */
    RCC_APB1ENR |= 1u << 31;
    LPTIM_CR = 0u;
    LPTIM_CFGR = 5u << 9; /* 32 分频：每秒 1024 格，16 位约 64 秒转一圈 */
    LPTIM_IER = LPTIM_CMPM;
    LPTIM_CR = LPTIM_ENABLE;
    LPTIM_ICR = LPTIM_ARROK | LPTIM_CMPOK;
    LPTIM_ARR = 0xFFFFu;
    if (!lptim_wait(LPTIM_ARROK)) {
        LPTIM_CR = 0u;
        return 0;
    }
    LPTIM_CR = LPTIM_ENABLE | LPTIM_CNTSTRT;
    EXTI_IMR |= LINE_LPTIM1;
    irq_enable(IRQ_LPTIM1);
    return 1;
}

/* 最多睡 ms 毫秒：比较值设在现在之后，到点 LPTIM 中断叫醒。 */
static void wake_after(uint32_t ms)
{
    LPTIM_ICR = LPTIM_CMPOK | LPTIM_CMPM;
    LPTIM_CMP = (lptim_count() + (ms * LPTIM_TICKS_PER_S) / 1000u) & 0xFFFFu;
    (void)lptim_wait(LPTIM_CMPOK);
}

/* LSE 起来以后：时钟改按 LPTIM 走（比 MSI 准得多），串口换 HSI16 以便 Stop 里收数据叫醒。 */
static void lse_poll(void)
{
    if (power_lse != 0u) {
        if (power_lse == 1u && clock_ticks_lost()) {
            /* 晶振中途停了：clock.c 已经退回 SysTick，这里不再进 Stop */
            power_lse = 2u;
            g_stop_ready = 0u;
        }
        return;
    }
    if ((RCC_CSR & LSE_RDY) != 0u) {
        if (!lptim_start()) {
            power_lse = 2u;
            return;
        }
        clock_follow_ticks(lptim_count);
        power_lse = 1u;
        g_stop_ready = uart2_use_hsi16() ? 1u : 0u;
        return;
    }
    if (clock_ms() >= LSE_TIMEOUT_MS) {
        RCC_CSR &= ~LSE_ON;
        power_lse = 2u;
    }
}

/* 进一次 Stop，醒来返回 1；关中断后发现有新变化（串口在收、引脚变了、来了事件）就不进，返回 0。 */
static int stop(int (*can_stop)(void))
{
    wake_after(BOARD_STOP_WAKE_MS);
    gd25_sleep();
    /* 关中断后再查一次串口：之后来的字节会让 wfi 立刻返回，不会漏 */
    __asm volatile("cpsid i" ::: "memory");
    if (!uart2_rx_idle() || !can_stop()) {
        __asm volatile("cpsie i" ::: "memory");
        return 0;
    }
    uart2_stop_mode(1);
    PWR_CR = (PWR_CR & ~PWR_PDDS) | PWR_LPSDSR | PWR_CWUF;
    SCB_SCR |= SCB_SLEEPDEEP;
    __asm volatile("dsb\n\twfi\n\tisb" ::: "memory");
    SCB_SCR &= ~SCB_SLEEPDEEP;
    /* 低功耗稳压器只给 Stop 用；2 MHz 下的普通 Sleep 不能开它 */
    PWR_CR &= ~PWR_LPSDSR;
    /* Stop 会关掉 HSI16，这里重新打开，模块串口才有时钟；起不来就退回 MSI，以后只用 Sleep */
    if (!uart2_stop_mode(0)) {
        g_stop_ready = 0u;
    }
    /* 马上跑一次节拍：按 LPTIM 补上睡掉的时间，周期定时也在这里判断 */
    SCB_ICSR = SCB_PENDSTSET;
    power_stops++;
    __asm volatile("cpsie i" ::: "memory");
    return 1;
}

#endif

void power_init(void)
{
    power_stops = 0u;
    power_lse = 0u;
    clock_note_power(BOARD_LOW_POWER >= 1u ? 1 : 0);
#if BOARD_LOW_POWER >= 2u
    g_stop_ready = 0u;
    g_rx_seen = 0u;
    g_rx_at = 0u;
    RCC_APB1ENR |= 1u << 28;
    PWR_CR |= PWR_DBP;
    if ((RCC_CSR & LSE_RDY) == 0u) {
        RCC_CSR = (RCC_CSR & ~LSE_DRV) | LSE_DRV_MEDIUM_HIGH;
        RCC_CSR |= LSE_ON;
    }
    RCC_APB2ENR |= 1u << 0; /* SYSCFG */
    SYSCFG_EXTICR2 = (SYSCFG_EXTICR2 & ~(0xFu << 4)) | (1u << 4); /* EXTI5 接 PB5 */
    SYSCFG_EXTICR3 = (SYSCFG_EXTICR3 & ~0xFFFu) | 0x111u;         /* EXTI8/9/10 接 PB8/PB9/PB10 */
    EXTI_RTSR |= LINE_PINS | LINE_PVD; /* PVD 上升沿：电压跌破门限 */
    EXTI_FTSR |= LINE_PINS;
    EXTI_PR = LINE_PINS | LINE_PVD;
    EXTI_IMR |= LINE_PINS | LINE_PVD | LINE_USART2;
    irq_enable(IRQ_EXTI4_15);
    irq_enable(IRQ_PVD);
#endif
}

void power_idle(int (*can_stop)(void))
{
#if BOARD_LOW_POWER >= 2u
    uint32_t now;
    lse_poll();
    now = clock_ms();
    if (uart_rx_bytes != g_rx_seen) {
        g_rx_seen = uart_rx_bytes;
        g_rx_at = now;
    }
    if (g_stop_ready && now >= BOARD_STOP_AFTER_MS) {
        clock_note_power(2);
        if ((now - g_rx_at) >= RX_LINGER_MS && can_stop() && stop(can_stop)) {
            return;
        }
    } else {
        clock_note_power(1);
    }
#else
    (void)can_stop;
#endif
#if BOARD_LOW_POWER >= 1u
    /* Sleep：CPU 停，SysTick 每毫秒叫醒一次，串口、引脚中断随时叫醒 */
    __asm volatile("wfi" ::: "memory");
#endif
}

void EXTI4_15_IRQHandler(void)
{
    EXTI_PR = LINE_PINS;
}

void PVD_IRQHandler(void)
{
    EXTI_PR = LINE_PVD;
}

void LPTIM1_IRQHandler(void)
{
    LPTIM_ICR = LPTIM_CMPM | LPTIM_ARRM;
}
