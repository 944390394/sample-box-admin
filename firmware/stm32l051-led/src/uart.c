#include "board.h"
#include "gpio.h"
#include "ringbuf.h"
#include "uart.h"

#define USART_CR1 0x00u
#define USART_CR3 0x08u
#define USART_BRR 0x0Cu
#define USART_ISR 0x1Cu
#define USART_ICR 0x20u
#define USART_RDR 0x24u
#define USART_TDR 0x28u
#define USART_RXNE (1u << 5)
#define USART_ORE (1u << 3)
#define USART_ERRORS 0x0Fu /* PE、FE、NF、ORE，ICR 里同位清除 */
#define USART_RXNEIE (1u << 5)
#define USART2_IRQ 28u
#define USART1_IRQ 27u
#define NVIC_IPR6 (*(volatile uint32_t *)0xE000E418u) /* IRQ24..27，IRQ27 在最高字节 */
#define NVIC_IPR7 (*(volatile uint32_t *)0xE000E41Cu) /* IRQ28..31，IRQ28 在最低字节 */
#define NVIC_ISER (*(volatile uint32_t *)0xE000E100u)
#define USART_TXE (1u << 7)
#define USART_TC (1u << 6)
#define USART_TEACK (1u << 21)
#define USART_TE (1u << 3)
#define USART_RE (1u << 2)
#define USART_UE (1u << 0)
#define USART_UESM (1u << 1)
#define USART_BUSY (1u << 16)
#define USART_WUF (1u << 20)
#define USART_WUS_RXNE (3u << 20)
#define USART_WUFIE (1u << 22)
#define HSI16_HZ 16000000u

#define RCC_CR (*(volatile uint32_t *)0x40021000u)
#define RCC_CCIPR (*(volatile uint32_t *)0x4002104Cu)
#define RCC_HSI16ON (1u << 0)
#define RCC_HSI16KERON (1u << 1)
#define RCC_HSI16RDY (1u << 2)
#define RCC_APB2ENR (*(volatile uint32_t *)0x40021034u)
#define RCC_APB1ENR (*(volatile uint32_t *)0x40021038u)

/* 供 openocd 读：收到的字节数、环形缓冲满了丢掉的字节数、硬件错误（ORE/FE/NF/PE）次数。 */
volatile uint32_t uart_rx_bytes;
volatile uint32_t uart_rx_dropped;
volatile uint32_t uart_rx_errors;
/* 发送等不到 TXE、整行放弃的次数（串口没有时钟时才会出现）。 */
volatile uint32_t uart_tx_stalls;
static ring_t g_rx2;
/* USART1（CH340，USB 串口）只收短命令行，64 字节够用；中断收，主循环取。 */
#define RX1_SIZE 64u
static volatile uint8_t g_rx1[RX1_SIZE];
static volatile uint8_t g_rx1_head;
static volatile uint8_t g_rx1_tail;

static uint32_t baud_divider(void)
{
    return (BOARD_MSI_HZ + (BOARD_USART_BAUD / 2u)) / BOARD_USART_BAUD;
}

void uart_bind(uint32_t usart, uint32_t tx_port, uint32_t tx_pin, uint32_t rx_port, uint32_t rx_pin)
{
    volatile uint32_t *cr1 = (volatile uint32_t *)(usart + USART_CR1);
    volatile uint32_t *brr = (volatile uint32_t *)(usart + USART_BRR);
    volatile uint32_t *isr = (volatile uint32_t *)(usart + USART_ISR);
    uint32_t guard = 100000u;
    if (usart == BOARD_USART1) {
        RCC_APB2ENR |= 1u << 14;
    } else {
        RCC_APB1ENR |= 1u << 17;
    }
    gpio_set_alternate(tx_port, tx_pin, 4u, GPIO_PULL_UP);
    gpio_set_alternate(rx_port, rx_pin, 4u, GPIO_PULL_UP);
    *brr = baud_divider();
    if (usart == BOARD_USART2) {
        /* Stop 唤醒：收完一个字节（RXNE）就叫醒。WUS 只能在 UE=0 时写；UESM 进 Stop 前才打开。 */
        *(volatile uint32_t *)(usart + USART_CR3) = USART_WUS_RXNE | USART_WUFIE;
    }
    *cr1 = USART_UE;
    if (usart == BOARD_USART2) {
        /* 主循环忙着读写 GD25 时轮询会丢字节，改由中断收进环形缓冲。 */
        ring_clear(&g_rx2);
        *(volatile uint32_t *)(usart + USART_ICR) = USART_ERRORS;
        *cr1 = USART_UE | USART_TE | USART_RE | USART_RXNEIE;
        NVIC_IPR7 &= ~0xFFu; /* 最高优先级 */
        NVIC_ISER = 1u << USART2_IRQ;
    } else {
        /* USB 串口收命令：中断收进小缓冲，主循环忙着读写 GD25 时也不丢字节。优先级低于 USART2。 */
        g_rx1_head = 0;
        g_rx1_tail = 0;
        *(volatile uint32_t *)(usart + USART_ICR) = USART_ERRORS;
        *cr1 = USART_UE | USART_TE | USART_RE | USART_RXNEIE;
        NVIC_IPR6 = (NVIC_IPR6 & ~0xFF000000u) | 0x80000000u;
        NVIC_ISER = 1u << USART1_IRQ;
    }
    while ((*isr & USART_TEACK) == 0u && guard-- > 0u) {
    }
}

/*
 * 9600 下一个字节约 1 ms；2 MHz 时每格等待约 4 µs，这么多格约 200 ms，还发不出去就
 * 说明串口没有时钟（比如 HSI16 关了），放弃这一行，不能让主循环永远卡在这里。
 */
#define TX_GUARD 50000u

void uart_write_text(uint32_t usart, const char *text)
{
    volatile uint32_t *isr = (volatile uint32_t *)(usart + USART_ISR);
    volatile uint32_t *tdr = (volatile uint32_t *)(usart + USART_TDR);
    uint32_t guard;
    while (*text) {
        guard = TX_GUARD;
        while ((*isr & USART_TXE) == 0u) {
            if (--guard == 0u) {
                uart_tx_stalls++;
                return;
            }
        }
        *tdr = (uint8_t)*text;
        text++;
    }
    guard = TX_GUARD;
    while ((*isr & USART_TC) == 0u && --guard != 0u) {
    }
}

void USART1_IRQHandler(void)
{
    volatile uint32_t *isr = (volatile uint32_t *)(BOARD_USART1 + USART_ISR);
    volatile uint32_t *icr = (volatile uint32_t *)(BOARD_USART1 + USART_ICR);
    volatile uint32_t *rdr = (volatile uint32_t *)(BOARD_USART1 + USART_RDR);
    uint32_t status = *isr;
    if ((status & USART_ERRORS) != 0u) {
        *icr = USART_ERRORS;
    }
    while ((status & USART_RXNE) != 0u) {
        uint8_t byte = (uint8_t)*rdr;
        uint8_t next = (uint8_t)((g_rx1_head + 1u) % RX1_SIZE);
        if (next != g_rx1_tail) {
            g_rx1[g_rx1_head] = byte;
            g_rx1_head = next;
        }
        status = *isr;
        if ((status & USART_ERRORS) != 0u) {
            *icr = USART_ERRORS;
        }
    }
}

void USART2_IRQHandler(void)
{
    volatile uint32_t *isr = (volatile uint32_t *)(BOARD_USART2 + USART_ISR);
    volatile uint32_t *icr = (volatile uint32_t *)(BOARD_USART2 + USART_ICR);
    volatile uint32_t *rdr = (volatile uint32_t *)(BOARD_USART2 + USART_RDR);
    uint32_t status = *isr;
    if ((status & USART_WUF) != 0u) {
        *icr = USART_WUF;
    }
    if ((status & USART_ERRORS) != 0u) {
        uart_rx_errors++;
        *icr = USART_ERRORS;
    }
    /* ORE 时 RXNE 也可能置位，读走的这一字节仍然有效。 */
    while ((status & USART_RXNE) != 0u) {
        uint8_t byte = (uint8_t)*rdr;
        uart_rx_bytes++;
        if (!ring_push(&g_rx2, byte)) {
            uart_rx_dropped++;
        }
        status = *isr;
        if ((status & USART_ERRORS) != 0u) {
            uart_rx_errors++;
            *icr = USART_ERRORS;
        }
    }
}

int uart_read_byte(uint32_t usart, uint8_t *out)
{
    volatile uint32_t *isr = (volatile uint32_t *)(usart + USART_ISR);
    volatile uint32_t *rdr = (volatile uint32_t *)(usart + USART_RDR);
    uint32_t status;
    if (usart == BOARD_USART2) {
        return ring_pop(&g_rx2, out);
    }
    if (usart == BOARD_USART1) {
        uint8_t tail = g_rx1_tail;
        if (tail == g_rx1_head) {
            return 0;
        }
        *out = g_rx1[tail];
        g_rx1_tail = (uint8_t)((tail + 1u) % RX1_SIZE);
        return 1;
    }
    status = *isr;
    if ((status & USART_RXNE) == 0u) {
        if ((status & USART_ORE) != 0u) {
            (void)*rdr;
        }
        return 0;
    }
    *out = (uint8_t)*rdr;
    return 1;
}

/*
 * 改 USART2 的时钟源（0 = PCLK/MSI，2 = HSI16）和波特率。BRR 只能在 UE=0 时写，所以先关串口、改完按原样打开。
 * 调用方负责关中断：串口接收中断不能在这中间进来。
 */
static void usart2_clock(uint32_t sel, uint32_t divider)
{
    volatile uint32_t *cr1 = (volatile uint32_t *)(BOARD_USART2 + USART_CR1);
    volatile uint32_t *brr = (volatile uint32_t *)(BOARD_USART2 + USART_BRR);
    volatile uint32_t *isr = (volatile uint32_t *)(BOARD_USART2 + USART_ISR);
    uint32_t guard = 100000u;
    uint32_t saved = *cr1;
    *cr1 = 0u;
    RCC_CCIPR = (RCC_CCIPR & ~(3u << 2)) | (sel << 2);
    *brr = divider;
    *cr1 = saved;
    while ((*isr & USART_TEACK) == 0u && --guard != 0u) {
    }
}

/* 打开 HSI16 并等它稳定；起不来返回 0。 */
static int hsi16_on(uint32_t guard)
{
    RCC_CR |= RCC_HSI16ON | (BOARD_STOP_KEEP_HSI16 ? RCC_HSI16KERON : 0u);
    while ((RCC_CR & RCC_HSI16RDY) == 0u) {
        if (--guard == 0u) {
            return 0;
        }
    }
    return 1;
}

/**
 * USART2 改用 HSI16 做时钟（波特率误差也从 MSI 的 1% 降到 0.1%）。Stop 里 HSI16 是关的，
 * 串口检测到起始位会自己把它叫起来收完这个字节，所以模块发来的数据能把单片机从 Stop 叫醒。
 * 等串口空闲再切；HSI16 起不来就保持 MSI，返回 0。
 */
int uart2_use_hsi16(void)
{
    volatile uint32_t *isr = (volatile uint32_t *)(BOARD_USART2 + USART_ISR);
    uint32_t guard = 100000u;
    if (!hsi16_on(100000u)) {
        RCC_CR &= ~(RCC_HSI16ON | RCC_HSI16KERON);
        return 0;
    }
    while ((*isr & USART_BUSY) != 0u && --guard != 0u) {
    }
    __asm volatile("cpsid i" ::: "memory");
    usart2_clock(2u, (HSI16_HZ + (BOARD_USART_BAUD / 2u)) / BOARD_USART_BAUD);
    __asm volatile("cpsie i" ::: "memory");
    return 1;
}

/*
 * 进 Stop 前（on=1）打开 UESM：Stop 里串口检测到起始位会自己叫起 HSI16 收这个字节。
 * 醒来后（on=0）：进 Stop 时硬件会清掉 HSI16ON，必须重新打开，否则串口没有时钟，收发全停。
 * HSI16 起不来时把串口退回 MSI，返回 0，调用方以后不再进 Stop。两种都在关中断时调用。
 */
int uart2_stop_mode(int on)
{
    volatile uint32_t *cr1 = (volatile uint32_t *)(BOARD_USART2 + USART_CR1);
    if (on) {
        *cr1 |= USART_UESM;
        return 1;
    }
    if (!hsi16_on(10000u)) {
        *cr1 &= ~USART_UESM;
        usart2_clock(0u, baud_divider());
        RCC_CR &= ~(RCC_HSI16ON | RCC_HSI16KERON);
        return 0;
    }
    *cr1 &= ~USART_UESM;
    return 1;
}

/* 环形缓冲读空、没在收字节：这时进 Stop 不会丢数据。 */
int uart2_rx_idle(void)
{
    volatile uint32_t *isr = (volatile uint32_t *)(BOARD_USART2 + USART_ISR);
    return g_rx2.head == g_rx2.tail && (*isr & (USART_BUSY | USART_RXNE)) == 0u;
}
