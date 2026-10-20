#ifndef SAMPLE_BOX_LPUART_H
#define SAMPLE_BOX_LPUART_H

#include <stddef.h>
#include <stdint.h>

void lpuart_init(void);
void lpuart_write(const uint8_t *data, size_t len);
/* 读到一整行（去掉 CR）返回长度。超时且没有完整行返回 0，半行留到下次。 */
int lpuart_read_line(char *buf, size_t cap, uint32_t timeout_ms);

#endif
