#include "lpuart.h"

#include "board.h"
#include "delay.h"
#include "pins.h"

#include "stm32l0xx.h"

#include <string.h>

#define RX_CAP 128u

static volatile uint8_t rx_buf[RX_CAP];
static volatile uint8_t rx_w;
static volatile uint8_t rx_r;

void lpuart_init(void)
{
    lpuart_pins_init();
    RCC->APB1ENR |= RCC_APB1ENR_LPUART1EN;
    RCC->CCIPR = (RCC->CCIPR & ~RCC_CCIPR_LPUART1SEL) | RCC_CCIPR_LPUART1SEL_0 | RCC_CCIPR_LPUART1SEL_1;
    LPUART1->CR1 = 0;
    LPUART1->BRR = BOARD_LPUART_BRR;
    LPUART1->CR3 = USART_CR3_WUS_1;
    LPUART1->CR1 = USART_CR1_UESM | USART_CR1_TE | USART_CR1_RE | USART_CR1_RXNEIE | USART_CR1_UE;
    NVIC_SetPriority(LPUART1_IRQn, 1);
    NVIC_EnableIRQ(LPUART1_IRQn);
}

void LPUART1_IRQHandler(void)
{
    uint32_t isr = LPUART1->ISR;
    if ((isr & (USART_ISR_ORE | USART_ISR_FE | USART_ISR_NE)) != 0u) {
        LPUART1->ICR = USART_ICR_ORECF | USART_ICR_FECF | USART_ICR_NECF;
    }
    if ((isr & USART_ISR_RXNE) != 0u) {
        uint8_t byte = (uint8_t)LPUART1->RDR;
        uint8_t next = (uint8_t)((rx_w + 1u) % RX_CAP);
        if (next != rx_r) {
            rx_buf[rx_w] = byte;
            rx_w = next;
        }
    }
}

static int lpuart_getc(void)
{
    uint8_t byte;
    __disable_irq();
    if (rx_r == rx_w) {
        __enable_irq();
        return -1;
    }
    byte = rx_buf[rx_r];
    rx_r = (uint8_t)((rx_r + 1u) % RX_CAP);
    __enable_irq();
    return byte;
}

void lpuart_write(const uint8_t *data, size_t len)
{
    size_t i;
    for (i = 0; i < len; i++) {
        uint32_t spins = 1000000u;
        while ((LPUART1->ISR & USART_ISR_TXE) == 0u) {
            if (spins-- == 0u) {
                return;
            }
        }
        LPUART1->TDR = data[i];
    }
    {
        uint32_t spins = 1000000u;
        while ((LPUART1->ISR & USART_ISR_TC) == 0u) {
            if (spins-- == 0u) {
                return;
            }
        }
    }
}

int lpuart_read_line(char *buf, size_t cap, uint32_t timeout_ms)
{
    static char acc[128];
    static uint8_t len;
    uint32_t start = millis();

    if (cap == 0) {
        return -1;
    }
    for (;;) {
        int byte = lpuart_getc();
        if (byte >= 0) {
            if (byte == '\n') {
                size_t n = len;
                if (n > 0 && acc[n - 1u] == '\r') {
                    n--;
                }
                if (n >= cap) {
                    n = cap - 1u;
                }
                memcpy(buf, acc, n);
                buf[n] = '\0';
                len = 0;
                if (n == 0) {
                    continue;
                }
                return (int)n;
            }
            if (len < sizeof acc - 1u) {
                acc[len++] = (char)byte;
            } else {
                len = 0;
            }
        } else if ((millis() - start) >= timeout_ms) {
            return 0;
        }
    }
}
