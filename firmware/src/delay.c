#include "delay.h"

#include "stm32l0xx.h"

static volatile uint32_t g_ms;

void SysTick_Handler(void)
{
    g_ms++;
}

void delay_start(void)
{
    SysTick->LOAD = 16000u - 1u;
    SysTick->VAL = 0;
    SysTick->CTRL = SysTick_CTRL_CLKSOURCE_Msk | SysTick_CTRL_TICKINT_Msk | SysTick_CTRL_ENABLE_Msk;
}

uint32_t millis(void)
{
    return g_ms;
}

void delay_ms(uint32_t ms)
{
    uint32_t start = g_ms;
    while ((g_ms - start) < ms) {
    }
}
