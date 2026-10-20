#include "spi_port.h"

#include "board.h"
#include "pins.h"

#include "stm32l0xx.h"

static int spi_xfer(void *ctx, const uint8_t *tx, uint8_t *rx, uint32_t len)
{
    uint32_t i;
    (void)ctx;
    for (i = 0; i < len; i++) {
        uint32_t spins = 100000u;
        while ((SPI1->SR & SPI_SR_TXE) == 0u) {
            if (spins-- == 0u) {
                return -1;
            }
        }
        *(volatile uint8_t *)&SPI1->DR = tx[i];
        spins = 100000u;
        while ((SPI1->SR & SPI_SR_RXNE) == 0u) {
            if (spins-- == 0u) {
                return -1;
            }
        }
        rx[i] = *(volatile uint8_t *)&SPI1->DR;
    }
    while ((SPI1->SR & SPI_SR_BSY) != 0u) {
    }
    return 0;
}

static void spi_cs(void *ctx, int level)
{
    (void)ctx;
    pin_write(GPIOA, BOARD_FLASH_CS_PIN, level);
}

void spi_port_init(spi_bus_t *bus, gd25_t *dev)
{
    spi_pins_init();
    RCC->APB2ENR |= RCC_APB2ENR_SPI1EN;
    SPI1->CR1 = 0;
    /* 8 位帧。FRXTH 不置位时 RXNE 要等 16 位，8 位传输会卡死。 */
    SPI1->CR2 = (7u << 8) | (1u << 12);
    SPI1->CR1 = SPI_CR1_MSTR | SPI_CR1_SSM | SPI_CR1_SSI | SPI_CR1_BR_1;
    SPI1->CR1 |= SPI_CR1_SPE;
    bus->ctx = 0;
    bus->xfer = spi_xfer;
    dev->bus = bus;
    dev->cs = spi_cs;
    dev->cs_ctx = 0;
}
