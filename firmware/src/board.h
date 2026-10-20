#ifndef SAMPLE_BOX_BOARD_H
#define SAMPLE_BOX_BOARD_H

/*
 * STM32L051C8T6（LQFP48）采样箱引脚。
 * 方案只定了功能和器件，没有原理图网表。下面是按这颗片子的外设能用的引脚排的，
 * 板子定稿后只改这个文件。极性也放在这里。
 *
 * PA13/PA14 留给 SWD，PC14/PC15 接 32.768 kHz。
 */

#define BOARD_LPUART_TX_PIN 2u
#define BOARD_LPUART_RX_PIN 3u
#define BOARD_LPUART_AF 6u
#define BOARD_LPUART_BRR 874u
#define BOARD_UART_BAUD 9600u

#define BOARD_FLASH_CS_PIN 4u
#define BOARD_SPI_SCK_PIN 5u
#define BOARD_SPI_MISO_PIN 6u
#define BOARD_SPI_MOSI_PIN 7u

#define BOARD_MOD_PWR_PIN 0u
#define BOARD_MOD_RST_PIN 1u
#define BOARD_MOD_RDY_PIN 2u
#define BOARD_LID_PIN 4u
#define BOARD_LED0_PIN 12u

#define BOARD_BUTTON_PIN 13u
#define BOARD_VBAT_PIN 0u
#define BOARD_VBAT_CHANNEL 10u

#define BOARD_LID_OPEN_LOW 1
#define BOARD_BUTTON_ACTIVE_LOW 1
#define BOARD_LED_ACTIVE_HIGH 1
#define BOARD_MOD_PWR_ACTIVE_HIGH 1
#define BOARD_MOD_RST_ACTIVE_LOW 1
#define BOARD_MOD_RDY_ACTIVE_HIGH 1

#define BOARD_VDDA_MV 3300u
#define BOARD_VBAT_NUM 2u
#define BOARD_VBAT_DEN 1u

#define BOARD_LONG_PRESS_MS 2000u
#define BOARD_DEBOUNCE_MS 20u
#define BOARD_LED_HOLD_MS 3000u
#define BOARD_AA55_DELAY_MS 200u
#define BOARD_RST_PULSE_MS 100u
#define BOARD_RDY_WAIT_MS 45000u
#define BOARD_DOWNLINK_QUIET_MS 2000u
#define BOARD_SEND_BURST 16

/*
 * 后台 TCP 还不会回 cmd=ack。RDY 为高说明模组已经联网，这一行交给模组后就从队列删掉，
 * 避免每次醒来把历史全部重发。RDY 超时则留在 GD25Q80C，下次按顺序补传。
 * 平台确认做完以后把这个改成 0，只认 cmd=ack,seq=N。
 */
#define BOARD_DROP_WHEN_MODEM_ACCEPTS 1

#endif
