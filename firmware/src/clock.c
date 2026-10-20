#include "clock.h"

#include "delay.h"

#include "stm32l0xx.h"

static int wait_set(volatile uint32_t *reg, uint32_t mask, uint32_t spins)
{
    while ((*reg & mask) == 0u) {
        if (spins-- == 0u) {
            return -1;
        }
    }
    return 0;
}

int clock_init(void)
{
    RCC->APB1ENR |= RCC_APB1ENR_PWREN;
    PWR->CR = (PWR->CR & ~PWR_CR_VOS) | PWR_CR_VOS_1;
    {
        /* VOSF 在切换电压档期间为 1。档位没切完就升频会违反手册。 */
        uint32_t spins = 100000u;
        while ((PWR->CSR & PWR_CSR_VOSF) != 0u && spins-- > 0u) {
        }
    }

    /* 16 MHz、电压档 2 需要 1 个等待周期。先加等待再切时钟。 */
    FLASH->ACR |= FLASH_ACR_LATENCY | FLASH_ACR_PRFTEN;
    while ((FLASH->ACR & FLASH_ACR_LATENCY) == 0u) {
    }

    RCC->CR |= RCC_CR_HSION;
    if (wait_set(&RCC->CR, RCC_CR_HSIRDY, 100000u) != 0) {
        return -1;
    }
    RCC->CFGR = (RCC->CFGR & ~RCC_CFGR_SW) | RCC_CFGR_SW_HSI;
    while ((RCC->CFGR & RCC_CFGR_SWS) != RCC_CFGR_SWS_HSI) {
    }
    SystemCoreClock = 16000000u;
    delay_start();

    PWR->CR |= PWR_CR_DBP;
    if ((RCC->CSR & RCC_CSR_LSERDY) == 0u) {
        RCC->CSR = (RCC->CSR & ~RCC_CSR_LSEDRV) | RCC_CSR_LSEDRV_1;
        RCC->CSR |= RCC_CSR_LSEON;
        /* LSE 起振可能要一两秒。Stop 和 9600 的 LPUART 都靠它。 */
        if (wait_set(&RCC->CSR, RCC_CSR_LSERDY, 20000000u) != 0) {
            return -1;
        }
    }
    if ((RCC->CSR & RCC_CSR_RTCSEL) != RCC_CSR_RTCSEL_LSE) {
        RCC->CSR &= ~RCC_CSR_RTCEN;
        RCC->CSR = (RCC->CSR & ~RCC_CSR_RTCSEL) | RCC_CSR_RTCSEL_LSE;
    }
    RCC->CSR |= RCC_CSR_RTCEN;
    return 0;
}
