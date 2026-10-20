#include "pins.h"

#include "battery.h"
#include "board.h"
#include "delay.h"

void pins_clocks(void)
{
    RCC->IOPENR |= RCC_IOPENR_IOPAEN | RCC_IOPENR_IOPBEN | RCC_IOPENR_IOPCEN;
}

void pin_mode(GPIO_TypeDef *port, unsigned pin, unsigned mode)
{
    uint32_t shift = pin * 2u;
    port->MODER = (port->MODER & ~(3u << shift)) | ((mode & 3u) << shift);
}

void pin_pull(GPIO_TypeDef *port, unsigned pin, unsigned pull)
{
    uint32_t shift = pin * 2u;
    port->PUPDR = (port->PUPDR & ~(3u << shift)) | ((pull & 3u) << shift);
}

void pin_af(GPIO_TypeDef *port, unsigned pin, unsigned af)
{
    unsigned index = pin >> 3;
    unsigned shift = (pin & 7u) * 4u;
    port->AFR[index] = (port->AFR[index] & ~(0xFu << shift)) | ((af & 0xFu) << shift);
}

void pin_write(GPIO_TypeDef *port, unsigned pin, int high)
{
    port->BSRR = high ? (1u << pin) : (1u << (pin + 16u));
}

int pin_read(GPIO_TypeDef *port, unsigned pin)
{
    return (port->IDR & (1u << pin)) != 0u;
}

void leds_init(void)
{
    unsigned pin;
    for (pin = BOARD_LED0_PIN; pin < BOARD_LED0_PIN + 4u; pin++) {
        pin_write(GPIOB, pin, 0);
        pin_mode(GPIOB, pin, 1);
    }
}

void leds_set(int mask)
{
    unsigned i;
    for (i = 0; i < 4u; i++) {
        int on = (mask & (1 << i)) != 0;
        pin_write(GPIOB, BOARD_LED0_PIN + i, BOARD_LED_ACTIVE_HIGH ? on : !on);
    }
}

void leds_show(uint16_t mv)
{
    int mask = battery_led_mask(battery_percent(mv));
    int i;
    if ((mask & 0x80) != 0) {
        for (i = 0; i < 6; i++) {
            leds_set((i & 1) != 0 ? 0x01 : 0);
            delay_ms(250);
        }
    } else {
        leds_set(mask);
        delay_ms(BOARD_LED_HOLD_MS);
    }
    leds_set(0);
}

void leds_blink_all(void)
{
    for (;;) {
        leds_set(0x0F);
        delay_ms(200);
        leds_set(0);
        delay_ms(200);
    }
}

void spi_pins_init(void)
{
    pin_write(GPIOA, BOARD_FLASH_CS_PIN, 1);
    pin_mode(GPIOA, BOARD_FLASH_CS_PIN, 1);
    pin_af(GPIOA, BOARD_SPI_SCK_PIN, 0);
    pin_af(GPIOA, BOARD_SPI_MISO_PIN, 0);
    pin_af(GPIOA, BOARD_SPI_MOSI_PIN, 0);
    pin_mode(GPIOA, BOARD_SPI_SCK_PIN, 2);
    pin_mode(GPIOA, BOARD_SPI_MISO_PIN, 2);
    pin_mode(GPIOA, BOARD_SPI_MOSI_PIN, 2);
}

void lpuart_pins_init(void)
{
    pin_pull(GPIOA, BOARD_LPUART_RX_PIN, 1);
    pin_af(GPIOA, BOARD_LPUART_TX_PIN, BOARD_LPUART_AF);
    pin_af(GPIOA, BOARD_LPUART_RX_PIN, BOARD_LPUART_AF);
    pin_mode(GPIOA, BOARD_LPUART_TX_PIN, 2);
    pin_mode(GPIOA, BOARD_LPUART_RX_PIN, 2);
}

void module_pins_init(void)
{
    pin_pull(GPIOB, BOARD_MOD_RDY_PIN, 2);
    pin_mode(GPIOB, BOARD_MOD_RDY_PIN, 0);
}

void input_pins_init(void)
{
    pin_pull(GPIOB, BOARD_LID_PIN, 1);
    pin_mode(GPIOB, BOARD_LID_PIN, 0);
    pin_pull(GPIOC, BOARD_BUTTON_PIN, 1);
    pin_mode(GPIOC, BOARD_BUTTON_PIN, 0);
}

void adc_pin_init(void)
{
    pin_mode(GPIOC, BOARD_VBAT_PIN, 3);
}
