#ifndef GPIO_H
#define GPIO_H

#include <stdint.h>

typedef enum {
    GPIO_PULL_NONE = 0,
    GPIO_PULL_UP = 1,
    GPIO_PULL_DOWN = 2,
} gpio_pull_t;

void gpio_ports_enable(void);
void gpio_set_output(uint32_t port, uint32_t pin);
void gpio_set_input(uint32_t port, uint32_t pin, gpio_pull_t pull);
void gpio_set_analog(uint32_t port, uint32_t pin);
void gpio_set_alternate(uint32_t port, uint32_t pin, uint32_t alternate, gpio_pull_t pull);
void gpio_write(uint32_t port, uint32_t pin, int high);
int gpio_read(uint32_t port, uint32_t pin);

#endif
