#include "inputs.h"

#include "board.h"
#include "delay.h"
#include "pins.h"

#include "stm32l0xx.h"

static volatile uint8_t flag_button;
static volatile uint8_t flag_lid;
static int lid_level_open;

static int button_down(void)
{
    int low = !pin_read(GPIOC, BOARD_BUTTON_PIN);
    return BOARD_BUTTON_ACTIVE_LOW ? low : !low;
}

int lid_is_open(void)
{
    int low = !pin_read(GPIOB, BOARD_LID_PIN);
    return BOARD_LID_OPEN_LOW ? low : !low;
}

void inputs_init(void)
{
    input_pins_init();
    RCC->APB2ENR |= RCC_APB2ENR_SYSCFGEN;
    SYSCFG->EXTICR[1] = (SYSCFG->EXTICR[1] & ~SYSCFG_EXTICR2_EXTI4) | SYSCFG_EXTICR2_EXTI4_PB;
    SYSCFG->EXTICR[3] = (SYSCFG->EXTICR[3] & ~SYSCFG_EXTICR4_EXTI13) | SYSCFG_EXTICR4_EXTI13_PC;
    EXTI->IMR |= (1u << BOARD_LID_PIN) | (1u << BOARD_BUTTON_PIN);
    EXTI->FTSR |= (1u << BOARD_LID_PIN) | (1u << BOARD_BUTTON_PIN);
    EXTI->RTSR |= (1u << BOARD_LID_PIN);
    lid_level_open = lid_is_open();
    NVIC_SetPriority(EXTI4_15_IRQn, 1);
    NVIC_EnableIRQ(EXTI4_15_IRQn);
}

void lid_irq_set(int enable)
{
    if (enable) {
        EXTI->IMR |= (1u << BOARD_LID_PIN);
        return;
    }
    EXTI->IMR &= ~(1u << BOARD_LID_PIN);
    flag_lid = 0;
}

void EXTI4_15_IRQHandler(void)
{
    uint32_t pending = EXTI->PR;
    if ((pending & EXTI_PR_PIF13) != 0u) {
        flag_button = 1;
        EXTI->PR = EXTI_PR_PIF13;
    }
    if ((pending & EXTI_PR_PIF4) != 0u) {
        flag_lid = 1;
        EXTI->PR = EXTI_PR_PIF4;
    }
}

int take_button_gesture(void)
{
    uint32_t start;
    if (flag_button == 0u) {
        return 0;
    }
    flag_button = 0;
    delay_ms(BOARD_DEBOUNCE_MS);
    if (!button_down()) {
        return 0;
    }
    start = millis();
    while (button_down()) {
        if ((millis() - start) >= BOARD_LONG_PRESS_MS) {
            return 2;
        }
    }
    return 1;
}

void take_lid_edge(int *opened, int *closed)
{
    int now;
    *opened = 0;
    *closed = 0;
    if (flag_lid == 0u) {
        return;
    }
    flag_lid = 0;
    delay_ms(BOARD_DEBOUNCE_MS);
    now = lid_is_open();
    if (now && !lid_level_open) {
        *opened = 1;
    }
    if (!now && lid_level_open) {
        *closed = 1;
    }
    lid_level_open = now;
}
