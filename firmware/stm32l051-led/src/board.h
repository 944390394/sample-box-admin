#ifndef BOARD_H
#define BOARD_H

#include <stdint.h>

/* STM32L051 复位后 MSI 为 2.097 MHz。本轮不切换 8 MHz 晶振。 */
#define BOARD_MSI_HZ 2097000u
#define BOARD_SYSTICK_HZ 1000u

/*
 * 两个串口共用。模块串口（USART2）要能把单片机从 Stop 叫醒，数据手册限 42 kbaud 以内，
 * 115200 下醒来常把一行的第一个字节收坏，1.0.14 起改 9600。DTU 平台的串口波特率必须同时改成 9600。
 */
#define BOARD_USART_BAUD 9600u
/* 写进每条上报的 fw=。改程序时顺手加版本号。 */
#define BOARD_FIRMWARE "1.0.19"
/* 没收到服务器周期前的默认值。网页上的默认周期会在确认包里改掉它。 */
#define BOARD_REPORT_PERIOD_MS 60000u
#define BOARD_LID_DEBOUNCE_MS 30u
/* PB10 箱盖只用板上 R4 470k 上拉；内部上拉（约 40k）开盖期间多耗约 80 µA。板子没焊 R4 时改成 1。 */
#define BOARD_LID_INTERNAL_PULLUP 0u

/*
 * 低功耗等级（power.c）：
 * 0 不休眠，主循环一直空转（1.0.11 及以前的做法，约 0.3 mA）；
 * 1 空闲时 Sleep：CPU 停，1 ms 节拍照跑；
 * 2 空闲时 Stop：只剩 32.768k 晶振计时，约 1–2 µA；每秒醒一次，开盖、充电、按键、串口来数据、掉电随时叫醒。
 * Stop 在板子上出问题时改成 1 重新编译烧录即可退回。
 */
#define BOARD_LOW_POWER 2u
/* 上电或按复位键后这么久内只用 Sleep：给 ST-Link 留连接窗口（SWD 座子没引 NRST），也让开机对时、上电报文先做完。 */
#define BOARD_STOP_AFTER_MS 60000u
/* Stop 里最长睡这么久就醒一次，处理补传重发、离线判断这类按时间走的事。 */
#define BOARD_STOP_WAKE_MS 1000u
/*
 * Stop 里串口靠「检测到起始位时自动打开 HSI16」收字节叫醒单片机。实测收不到时改成 1：
 * Stop 里一直开着 HSI16（多耗约 0.1 mA，仍比不休眠省一半以上）。
 */
#define BOARD_STOP_KEEP_HSI16 0u
/* 上电后最多等这么久。模块没把 ntp= 写过来也要发出上电报文。 */
#define BOARD_NTP_WAIT_MS 60000u
/* RDY 连续这么久才发 why=boot。复位瞬间串口写出去时，模块经常还没开始收。 */
#define BOARD_BOOT_HOLD_MS 8000u

/*
 * PA1 接到 100k/100k 中点，ADC 看到的是电池电压的一半。
 * 换算时把 VDDA 当作 3.3 V。板子若直接用电池给 VDDA 供电，读数会偏。
 */
#define BOARD_VDDA_MV 3300u
#define BOARD_BATTERY_RATIO 2u

#define BOARD_PORT_A 0x50000000u
#define BOARD_PORT_B 0x50000400u

#define BOARD_PIN_BATTERY 1u
#define BOARD_PIN_USART2_TX 2u
#define BOARD_PIN_USART2_RX 3u
#define BOARD_PIN_FLASH_CS 4u
#define BOARD_PIN_SPI_SCK 5u
#define BOARD_PIN_SPI_MISO 6u
#define BOARD_PIN_SPI_MOSI 7u
#define BOARD_PIN_USART1_TX 9u
#define BOARD_PIN_USART1_RX 10u

/* -1 leaves PB0 high impedance. Select 0/1 only on a measured wake-capable board. */
#ifndef BOARD_DTR_WAKE_LEVEL
#define BOARD_DTR_WAKE_LEVEL (-1)
#endif
#define BOARD_PIN_DTR 0u
#define BOARD_PIN_RST 1u
#define BOARD_PIN_FACTORY 5u /* PB5，按键接 GND；SPI SCK 仍为 PA5。 */
#define BOARD_PIN_CHRG 8u
#define BOARD_PIN_STDBY 9u
#define BOARD_PIN_LID 10u
#define BOARD_PIN_RDY 11u
#define BOARD_PIN_LED_LID 12u
#define BOARD_PIN_LED_CHG 13u
#define BOARD_PIN_LED_RDY 14u

#define BOARD_USART1 0x40013800u
#define BOARD_USART2 0x40004400u

#endif
