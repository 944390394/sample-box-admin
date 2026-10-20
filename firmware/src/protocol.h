#ifndef SAMPLE_BOX_PROTOCOL_H
#define SAMPLE_BOX_PROTOCOL_H

#include <stddef.h>
#include <stdint.h>

#define PROTOCOL_LINE_MAX 96

typedef enum {
    PROTO_KIND_CMD = 1,
    PROTO_KIND_ACK = 2
} proto_kind_t;

typedef enum {
    BOX_CMD_START = 1,
    BOX_CMD_STOP = 2,
    BOX_CMD_RESET = 3,
    BOX_CMD_INTERVAL = 4
} box_cmd_type_t;

typedef struct {
    proto_kind_t kind;
    box_cmd_type_t cmd;
    int has_interval;
    uint32_t interval_sec;
    int has_seq;
    uint32_t seq;
} proto_msg_t;

/* 一行，不带换行。成功返回字符数，缓冲不够返回 -1。 */
int protocol_format(const char *why, int lid_open, uint16_t opens, uint32_t seq, int cached,
                    uint16_t mv, char *buf, size_t cap);

/* 解析模组转发下来的一行。成功返回 0。 */
int protocol_parse(const char *line, proto_msg_t *msg);

#endif
