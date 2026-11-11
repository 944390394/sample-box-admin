#ifndef POFF_H
#define POFF_H

#include <stdint.h>

/* 掉电前的最后时间记在 GD25Q32 里。电压已经是 0 时写不进去。 */
void poff_init(void);
void poff_poll(void);
int poff_has(void);
uint64_t poff_ms(void);
void poff_note_boot(int lid_open, int charge);
/* 开箱次数和掉电时间记在同一条闪存记录里，复位后还能读回来。 */
uint32_t poff_opens(void);
int poff_note_opens(uint32_t opens);
int poff_ready(void);
int poff_power_low(void);
uint32_t poff_free(void);
/* 远程抹除：每次擦一个扇区，*sector 为进度。full 为 0 时跳过空白扇区。1 完成并重置写指针，0 进行中，-1 失败。 */
int poff_erase_log(uint32_t *sector, int full);
/* 导出用：下一条写入位置，和按已用扇区估算的条数。 */
uint32_t poff_log_next(void);
uint32_t poff_log_total(void);

#endif
