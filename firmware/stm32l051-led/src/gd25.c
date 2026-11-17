#include "board.h"
#include "clock.h"
#include "gd25.h"
#include "gpio.h"

#define SPI1 0x40013000u
#define SPI_CR1 0x00u
#define SPI_CR2 0x04u
#define SPI_SR 0x08u
#define SPI_DR 0x0Cu
#define SPI_TXE (1u << 1)
#define SPI_RXNE (1u << 0)
#define SPI_BSY (1u << 7)

#define RCC_APB2ENR (*(volatile uint32_t *)0x40021034u)

#define CMD_WRITE_ENABLE 0x06u
#define CMD_READ_STATUS 0x05u
#define CMD_READ 0x03u
#define CMD_PAGE_PROGRAM 0x02u
#define CMD_SECTOR_ERASE 0x20u
#define CMD_JEDEC 0x9Fu
#define CMD_DEEP_POWER_DOWN 0xB9u
#define CMD_RELEASE 0xABu
#define STATUS_BUSY 0x01u

volatile uint32_t box_flash_id;

/* 空闲时进深度掉电（待机电流从几 µA 降到 1 µA 以下），下次读写前先唤醒。 */
static uint8_t g_spi_ready;
static uint8_t g_asleep;

static void cs_high(void)
{
    gpio_write(BOARD_PORT_A, BOARD_PIN_FLASH_CS, 1);
}

static void cs_low(void)
{
    gpio_write(BOARD_PORT_A, BOARD_PIN_FLASH_CS, 0);
}

static uint8_t spi_byte(uint8_t out)
{
    volatile uint32_t *sr = (volatile uint32_t *)(SPI1 + SPI_SR);
    volatile uint8_t *dr = (volatile uint8_t *)(SPI1 + SPI_DR);
    uint32_t guard = 100000u;
    while ((*sr & SPI_TXE) == 0u && guard-- > 0u) {
    }
    *dr = out;
    guard = 100000u;
    while ((*sr & SPI_RXNE) == 0u && guard-- > 0u) {
    }
    return *dr;
}

static void spi_finish(void)
{
    volatile uint32_t *sr = (volatile uint32_t *)(SPI1 + SPI_SR);
    uint32_t guard = 100000u;
    while ((*sr & SPI_BSY) != 0u && guard-- > 0u) {
    }
}

static void write_enable(void)
{
    cs_low();
    spi_byte(CMD_WRITE_ENABLE);
    spi_finish();
    cs_high();
}

static uint8_t status(void)
{
    uint8_t value;
    cs_low();
    spi_byte(CMD_READ_STATUS);
    value = spi_byte(0x00u);
    spi_finish();
    cs_high();
    return value;
}

static int wait_ready(uint32_t timeout_ms)
{
    uint32_t start = clock_ms();
    while ((status() & STATUS_BUSY) != 0u) {
        if ((clock_ms() - start) >= timeout_ms) {
            return 0;
        }
    }
    return 1;
}

/* 唤醒后要等 tRES1（GD25Q32 最多约 20 µs）；这里在 2 MHz 下大约等 150 µs。 */
static void release(void)
{
    volatile uint32_t n;
    cs_low();
    spi_byte(CMD_RELEASE);
    spi_finish();
    cs_high();
    for (n = 0; n < 40u; n++) {
    }
    g_asleep = 0;
}

static void wake(void)
{
    if (g_asleep) {
        release();
    }
}

void gd25_sleep(void)
{
    if (!g_spi_ready || g_asleep) {
        return;
    }
    cs_low();
    spi_byte(CMD_DEEP_POWER_DOWN);
    spi_finish();
    cs_high();
    g_asleep = 1;
}

static void send_addr(uint8_t command, uint32_t addr)
{
    spi_byte(command);
    spi_byte((uint8_t)(addr >> 16));
    spi_byte((uint8_t)(addr >> 8));
    spi_byte((uint8_t)addr);
}

int gd25_init(void)
{
    volatile uint32_t *cr1 = (volatile uint32_t *)(SPI1 + SPI_CR1);
    volatile uint32_t *cr2 = (volatile uint32_t *)(SPI1 + SPI_CR2);
    uint8_t id[3];
    gpio_write(BOARD_PORT_A, BOARD_PIN_FLASH_CS, 1);
    gpio_set_output(BOARD_PORT_A, BOARD_PIN_FLASH_CS);
    gpio_set_alternate(BOARD_PORT_A, BOARD_PIN_SPI_SCK, 0u, GPIO_PULL_NONE);
    gpio_set_alternate(BOARD_PORT_A, BOARD_PIN_SPI_MISO, 0u, GPIO_PULL_UP);
    gpio_set_alternate(BOARD_PORT_A, BOARD_PIN_SPI_MOSI, 0u, GPIO_PULL_NONE);
    RCC_APB2ENR |= 1u << 12;
    *cr1 = (1u << 2) | (1u << 8) | (1u << 9);
    *cr2 = (7u << 8) | (1u << 12);
    *cr1 |= 1u << 6;
    g_spi_ready = 1;
    /* 软件复位（恢复出厂、抹除）前它可能正在深度掉电，不先唤醒就读不到 ID */
    release();
    cs_low();
    spi_byte(CMD_JEDEC);
    id[0] = spi_byte(0x00u);
    id[1] = spi_byte(0x00u);
    id[2] = spi_byte(0x00u);
    spi_finish();
    cs_high();
    box_flash_id = ((uint32_t)id[0] << 16) | ((uint32_t)id[1] << 8) | id[2];
    return box_flash_id == 0x00C84016u;
}

void gd25_read(uint32_t addr, uint8_t *dst, unsigned length)
{
    unsigned index;
    wake();
    cs_low();
    send_addr(CMD_READ, addr);
    for (index = 0; index < length; index++) {
        dst[index] = spi_byte(0x00u);
    }
    spi_finish();
    cs_high();
}

int gd25_page_program(uint32_t addr, const uint8_t *src, unsigned length)
{
    unsigned index;
    if (length == 0u || length > GD25_PAGE) {
        return 0;
    }
    if (((addr & (GD25_PAGE - 1u)) + length) > GD25_PAGE) {
        return 0;
    }
    wake();
    if (!wait_ready(20u)) {
        return 0;
    }
    write_enable();
    cs_low();
    send_addr(CMD_PAGE_PROGRAM, addr);
    for (index = 0; index < length; index++) {
        spi_byte(src[index]);
    }
    spi_finish();
    cs_high();
    return wait_ready(20u);
}

int gd25_erase_sector(uint32_t addr)
{
    wake();
    if (!wait_ready(20u)) {
        return 0;
    }
    write_enable();
    cs_low();
    send_addr(CMD_SECTOR_ERASE, addr);
    spi_finish();
    cs_high();
    return wait_ready(2000u);
}
