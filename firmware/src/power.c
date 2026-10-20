#include "power.h"

#include "stm32l0xx.h"

void power_enter_stop(void)
{
    PWR->CR |= PWR_CR_CWUF;
    PWR->CR &= ~PWR_CR_PDDS;
    PWR->CR |= PWR_CR_LPSDSR;
    SCB->SCR |= SCB_SCR_SLEEPDEEP_Msk;
    __DSB();
    __WFI();
    SCB->SCR &= ~SCB_SCR_SLEEPDEEP_Msk;
}
