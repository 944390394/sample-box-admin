#include "adc_vbat.h"

#include "board.h"
#include "delay.h"
#include "pins.h"

#include "stm32l0xx.h"

static int adc_ready;

static int adc_calibrate(void)
{
    uint32_t spins;

    RCC->APB2ENR |= RCC_APB2ENR_ADCEN;
    ADC1->CFGR2 = (ADC1->CFGR2 & ~ADC_CFGR2_CKMODE) | ADC_CFGR2_CKMODE_0;
    if ((ADC1->CR & ADC_CR_ADEN) != 0u) {
        ADC1->CR |= ADC_CR_ADDIS;
        spins = 100000u;
        while ((ADC1->CR & ADC_CR_ADEN) != 0u) {
            if (spins-- == 0u) {
                return -1;
            }
        }
    }
    ADC1->CR |= ADC_CR_ADVREGEN;
    delay_ms(1);
    ADC1->CR |= ADC_CR_ADCAL;
    spins = 1000000u;
    while ((ADC1->CR & ADC_CR_ADCAL) != 0u) {
        if (spins-- == 0u) {
            return -1;
        }
    }
    ADC1->ISR = ADC_ISR_ADRDY;
    ADC1->CR |= ADC_CR_ADEN;
    spins = 100000u;
    while ((ADC1->ISR & ADC_ISR_ADRDY) == 0u) {
        if (spins-- == 0u) {
            return -1;
        }
    }
    return 0;
}

uint16_t adc_vbat_mv(void)
{
    uint32_t raw;
    uint32_t mv;
    uint32_t spins = 1000000u;

    if (!adc_ready) {
        adc_pin_init();
        if (adc_calibrate() != 0) {
            return 0;
        }
        adc_ready = 1;
    }
    ADC1->CHSELR = ADC_CHSELR_CHSEL10;
    ADC1->SMPR = ADC_SMPR_SMP_0 | ADC_SMPR_SMP_1 | ADC_SMPR_SMP_2;
    ADC1->ISR = ADC_ISR_EOC;
    ADC1->CR |= ADC_CR_ADSTART;
    while ((ADC1->ISR & ADC_ISR_EOC) == 0u) {
        if (spins-- == 0u) {
            return 0;
        }
    }
    raw = ADC1->DR & 0xFFFu;
    mv = raw * BOARD_VDDA_MV / 4095u;
    mv = mv * BOARD_VBAT_NUM / BOARD_VBAT_DEN;
    if (mv > 65535u) {
        mv = 65535u;
    }
    return (uint16_t)mv;
}
