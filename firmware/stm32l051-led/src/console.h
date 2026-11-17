#ifndef CONSOLE_H
#define CONSOLE_H

#include <stdint.h>

/*
 * USART1 接到 CH340（USB 串口），9600 8N1。两个用途：
 * 1. 每条上报原样再写一份到这里（和发给模块的一样），验收时能直接看；
 * 2. 本地读取接口：网页（浏览器的 Web Serial）或上位机发一行命令，板子回一行或多行，
 *    回复都以 # 开头，和上报行区分开，每行 key=value 用空格分隔，方便程序解析。
 *
 *    help   列出命令                         #help info queue dump last
 *    info   当前状态                         #info fw=1.0.15 seq= opens= lid= chg= bat= link= t= period= pending= free=
 *    queue  没同步到服务器的记录有多少         #queue pending= flash= ring= next= qe=
 *    dump   逐条列出没同步的记录（最老的在前）  #rec i= q= bf= <原文>  …  #end n=
 *    last   最近一条上报                     #last <原文>
 *    不认识的命令                            #err cmd=<命令>
 *
 * 插着 USB（充电器有电）时单片机不进 Stop，命令随时能收；用电池时 CH340 没电，这个口不用。
 */
typedef struct {
    uint32_t seq;
    uint32_t opens;
    int lid_open;
    int charge;
    int battery_mv;
    int ready;
    const char *last_line;
} console_state_t;

void console_init(void);
void console_write(const char *text);
/* 主循环每圈调一次：读命令、回答；dump 每圈只吐一条，不长时间占住主循环。 */
void console_poll(const console_state_t *state);
/* 正在 dump：还有记录没吐完。 */
int console_busy(void);

#endif
