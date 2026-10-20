#ifndef SAMPLE_BOX_CRC16_H
#define SAMPLE_BOX_CRC16_H

#include <stddef.h>
#include <stdint.h>

/* CRC-16/CCITT-FALSE，初值 0xFFFF，多项式 0x1021。覆盖记录里除校验本身以外的字节。 */
uint16_t crc16(const void *data, size_t len);

#endif
