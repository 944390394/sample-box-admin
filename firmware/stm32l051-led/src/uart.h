#ifndef UART_H
#define UART_H

#include <stdint.h>

void uart_bind(uint32_t usart, uint32_t tx_port, uint32_t tx_pin, uint32_t rx_port, uint32_t rx_pin);
void uart_write_text(uint32_t usart, const char *text);
/* 没有新字节时返回 0。读走数据寄存器，顺带清掉溢出标志。 */
int uart_read_byte(uint32_t usart, uint8_t *out);

/* 低功耗（power.c）用：USART2 换 HSI16 时钟、进出 Stop 时开关唤醒、能不能进 Stop。 */
int uart2_use_hsi16(void);
/* on=0 时返回 0 表示醒来后 HSI16 起不来，串口已退回 MSI，不能再进 Stop。 */
int uart2_stop_mode(int on);
int uart2_rx_idle(void);

/* USART2 由中断收进环形缓冲；下面三个计数供 openocd 查看。 */
extern volatile uint32_t uart_rx_bytes;
extern volatile uint32_t uart_rx_dropped;
extern volatile uint32_t uart_rx_errors;
extern volatile uint32_t uart_tx_stalls;

#endif
