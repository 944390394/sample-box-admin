#ifndef POWER_H
#define POWER_H

#include <stdint.h>

/*
 * 空闲时让单片机休眠。等级见 board.h 的 BOARD_LOW_POWER。
 *
 * Stop 模式下 CPU、MSI、SysTick 都停，只剩 32.768k 晶振（LSE）带着 LPTIM1 计时，电流约 1–2 µA。
 * 叫醒它的有：LPTIM1 定时（最长 BOARD_STOP_WAKE_MS）、箱盖 PB10、充电 PB8/PB9、按键 PB5 的任意边沿、
 * 模块串口来数据（USART2 改用 HSI16 时钟，收完一个字节就叫醒）、电压跌破 PVD 门限。
 * 醒来后按 LPTIM1 补上睡掉的毫秒（clock.c），主循环照常转一圈再判断能不能接着睡。
 *
 * LSE 起不来、开机头 BOARD_STOP_AFTER_MS 内、或者还有事没做完（去抖、按键、补传在发、串口在收）时，
 * 只用 Sleep：CPU 停，1 ms 节拍照跑。
 */
void power_init(void);
/*
 * 主循环每转一圈调用一次。can_stop 返回非零表示业务上没有正在进行的事（事件、去抖、按键、补传在发等）。
 * 它会在关中断后再调一次，确认这期间没有新变化才进 Stop，所以只能读状态，不能有副作用。
 */
void power_idle(int (*can_stop)(void));

/* 供 openocd 查看：进过几次 Stop、LSE 状态（0 启动中，1 正常，2 起不来或中途停了）。 */
extern volatile uint32_t power_stops;
extern volatile uint32_t power_lse;

#endif
