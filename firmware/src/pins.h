#ifndef SAMPLE_BOX_PINS_H
#define SAMPLE_BOX_PINS_H

#include "stm32l0xx.h"

void pins_clocks(void);
void pin_mode(GPIO_TypeDef *port, unsigned pin, unsigned mode);
void pin_pull(GPIO_TypeDef *port, unsigned pin, unsigned pull);
void pin_af(GPIO_TypeDef *port, unsigned pin, unsigned af);
void pin_write(GPIO_TypeDef *port, unsigned pin, int high);
int pin_read(GPIO_TypeDef *port, unsigned pin);

void leds_init(void);
void leds_set(int mask);
void leds_show(uint16_t mv);
void leds_blink_all(void);

void spi_pins_init(void);
void module_pins_init(void);
void input_pins_init(void);
void adc_pin_init(void);
void lpuart_pins_init(void);

#endif
