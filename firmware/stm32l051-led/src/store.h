#ifndef STORE_H
#define STORE_H

#include <stdint.h>

typedef enum { STORE_CMD_WIPE = 1, STORE_CMD_DUMP_INFO, STORE_CMD_DUMP } store_cmd_kind_t;
/* 服务器写回的指令行：wipe m=<q|f> s=<seq>、dump q s=<seq>、dump f=<秒> n=<条数> s=<seq> r=<请求号>。 */
typedef struct {
    store_cmd_kind_t kind;
    uint8_t full;
    uint32_t from;
    uint32_t max;
    uint32_t seq;
    uint32_t req;
} store_cmd_t;

/*
 * 联网且 Flash 队列为空时，上报只放进 RAM 在途环并立刻发出，收到 a= 才移除；
 * 超时没确认、链路掉线或已有积压，才按序写进 GD25 末尾的离线区。
 * 积压按批补传，只靠 a=<n> 累计确认，没有 a= 的 ok 不确认任何记录。
 */
extern uint32_t store_write_failures, store_overflows;
void store_init(void);
int store_save(const char *text);
void store_poll(int link_up);
uint32_t store_pending(void);
/* 在线且还有补传没发出去。 */
int store_sending(void);
uint32_t store_free(void);
int store_available(void);
int store_durable_event(const char *text);
int store_factory_reset(void);
/* 取走最近解析出的指令行；一次只缓存一条。 */
int store_take_cmd(store_cmd_t *cmd);
/* 导出行不进补传队列、没有 ok：队列清空且距上一行满间隔时才可以直接写串口。 */
int store_stream_ready(void);
void store_stream(const char *text);
/*
 * USB 串口本地读取：没同步到服务器的记录就是 Flash 队列（头到尾）加在途环里的，
 * 收到服务器 a=<n> 才移出；不另设「已同步」标志位，队列本身就是未同步清单。
 */
int store_peek(uint32_t index, char *out, unsigned cap, uint32_t *q, int *in_flash);
void store_stats(uint32_t *flash, uint32_t *ring, uint32_t *next_q, uint32_t *epoch);

#endif
