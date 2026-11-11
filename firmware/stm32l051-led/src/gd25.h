#ifndef GD25_H
#define GD25_H

#include <stdint.h>

/* GD25Q32，32 Mbit。页编程不能跨过 256 字节边界。 */
#define GD25_BYTES 0x400000u
#define GD25_SECTOR 4096u
#define GD25_PAGE 256u
/* 最后 256KB 里，前面给离线补传，最后 4KB 单独存电池学习曲线。掉电日志不能写过这里。 */
#define GD25_LOG_LIMIT 0x3C0000u
#define GD25_CURVE_BASE 0x3FF000u

int gd25_init(void);
void gd25_read(uint32_t addr, uint8_t *dst, unsigned length);
int gd25_page_program(uint32_t addr, const uint8_t *src, unsigned length);
int gd25_erase_sector(uint32_t addr);
/* 进深度掉电；之后任何读写会先自动唤醒。只在主循环空闲（准备进 Stop）时调用。 */
void gd25_sleep(void);

#endif
