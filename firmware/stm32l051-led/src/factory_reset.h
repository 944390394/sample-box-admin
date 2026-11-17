#ifndef FACTORY_RESET_H
#define FACTORY_RESET_H
#include <stdint.h>
#include "led.h"

void factory_reset_init(led_t *led);
void factory_reset_on_ms(void);
/* 非零时暂停业务写入，清理在主循环执行，绝不在中断中访问 SPI。 */
int factory_reset_poll(void);
/* 远程抹除：full 为 0 为快速。进行中或已在恢复出厂时返回 0。流程同按键恢复，另外擦掉电日志区。 */
int factory_reset_wipe(int full);
/* 没按键、没在恢复或抹除、也没报错闪灯：可以进 Stop。 */
int factory_reset_idle(void);
#endif
