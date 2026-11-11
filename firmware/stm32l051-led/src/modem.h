#ifndef MODEM_H
#define MODEM_H

#include <stdint.h>

#define MODEM_SLOTS 4u
#define MODEM_LINE 240u

/*
 * USART2 接到 4G 模块。PB11 RDY 为高才发送。
 * 本板 4G_VIN 与电池短接，不能给模块断电。
 * DTR、RST、RDY 先浮空，避免单片机把模块拉住。
 */
typedef struct {
    char lines[MODEM_SLOTS][MODEM_LINE];
    char boot_line[MODEM_LINE];
    uint8_t head;
    uint8_t tail;
    uint8_t count;
    uint8_t has_boot;
    uint32_t dropped;
} modem_t;

void modem_init(modem_t *modem);
int modem_is_ready(void);
void modem_submit(modem_t *modem, const char *text);
/* 上电报文单独占一个位置，队列满了也不能把 why=boot 丢掉。就绪后它排在其它行前面。 */
void modem_submit_boot(modem_t *modem, const char *text);
void modem_flush(modem_t *modem);

#endif
