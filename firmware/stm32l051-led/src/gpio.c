#include "gpio.h"

#define GPIO_MODER 0x00u
#define GPIO_OTYPER 0x04u
#define GPIO_PUPDR 0x0Cu
#define GPIO_IDR 0x10u
#define GPIO_BSRR 0x18u
#define GPIO_AFRL 0x20u
#define GPIO_AFRH 0x24u

#define RCC_IOPENR (*(volatile uint32_t *)0x4002102Cu)

static void field_set(uint32_t port, uint32_t offset, uint32_t pin, uint32_t width, uint32_t value)
{
    volatile uint32_t *reg = (volatile uint32_t *)(port + offset);
    uint32_t shift = pin * width;
    uint32_t mask = ((1u << width) - 1u) << shift;
    *reg = (*reg & ~mask) | ((value << shift) & mask);
}

void gpio_ports_enable(void)
{
    RCC_IOPENR |= (1u << 0) | (1u << 1);
}

void gpio_write(uint32_t port, uint32_t pin, int high)
{
    volatile uint32_t *bsrr = (volatile uint32_t *)(port + GPIO_BSRR);
    if (high) {
        *bsrr = 1u << pin;
    } else {
        *bsrr = 1u << (pin + 16u);
    }
}

int gpio_read(uint32_t port, uint32_t pin)
{
    volatile uint32_t *idr = (volatile uint32_t *)(port + GPIO_IDR);
    return (*idr & (1u << pin)) != 0;
}

void gpio_set_output(uint32_t port, uint32_t pin)
{
    field_set(port, GPIO_OTYPER, pin, 1u, 0u);
    field_set(port, GPIO_PUPDR, pin, 2u, GPIO_PULL_NONE);
    field_set(port, GPIO_MODER, pin, 2u, 1u);
}

void gpio_set_input(uint32_t port, uint32_t pin, gpio_pull_t pull)
{
    field_set(port, GPIO_PUPDR, pin, 2u, (uint32_t)pull);
    field_set(port, GPIO_MODER, pin, 2u, 0u);
}

void gpio_set_analog(uint32_t port, uint32_t pin)
{
    field_set(port, GPIO_PUPDR, pin, 2u, GPIO_PULL_NONE);
    field_set(port, GPIO_MODER, pin, 2u, 3u);
}

void gpio_set_alternate(uint32_t port, uint32_t pin, uint32_t alternate, gpio_pull_t pull)
{
    uint32_t offset = pin < 8u ? GPIO_AFRL : GPIO_AFRH;
    uint32_t index = pin < 8u ? pin : pin - 8u;
    field_set(port, GPIO_OTYPER, pin, 1u, 0u);
    field_set(port, GPIO_PUPDR, pin, 2u, (uint32_t)pull);
    field_set(port, offset, index, 4u, alternate);
    field_set(port, GPIO_MODER, pin, 2u, 2u);
}
