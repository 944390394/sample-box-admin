#include "protocol.h"

#include <string.h>

static int append_text(char *buf, size_t cap, int pos, const char *text)
{
    size_t n = strlen(text);
    if ((size_t)pos + n >= cap) {
        return -1;
    }
    memcpy(buf + pos, text, n);
    return pos + (int)n;
}

static int append_u32(char *buf, size_t cap, int pos, uint32_t value)
{
    char tmp[10];
    int n = 0;
    int i;

    if (value == 0) {
        return append_text(buf, cap, pos, "0");
    }
    while (value > 0 && n < (int)sizeof tmp) {
        tmp[n++] = (char)('0' + (value % 10u));
        value /= 10u;
    }
    if ((size_t)pos + (size_t)n >= cap) {
        return -1;
    }
    for (i = 0; i < n; i++) {
        buf[pos + i] = tmp[n - 1 - i];
    }
    return pos + n;
}

int protocol_format(const char *why, int lid_open, uint16_t opens, uint32_t seq, int cached,
                    uint16_t mv, char *buf, size_t cap)
{
    int pos = 0;

    if (why == 0 || buf == 0 || cap == 0) {
        return -1;
    }
    pos = append_text(buf, cap, pos, "why=");
    if (pos < 0) {
        return -1;
    }
    pos = append_text(buf, cap, pos, why);
    if (pos < 0) {
        return -1;
    }
    pos = append_text(buf, cap, pos, ",opens=");
    if (pos < 0) {
        return -1;
    }
    pos = append_u32(buf, cap, pos, opens);
    if (pos < 0) {
        return -1;
    }
    pos = append_text(buf, cap, pos, lid_open ? ",lid=open" : ",lid=shut");
    if (pos < 0) {
        return -1;
    }
    pos = append_text(buf, cap, pos, ",seq=");
    if (pos < 0) {
        return -1;
    }
    pos = append_u32(buf, cap, pos, seq);
    if (pos < 0) {
        return -1;
    }
    pos = append_text(buf, cap, pos, cached ? ",cached=1" : ",cached=0");
    if (pos < 0) {
        return -1;
    }
    pos = append_text(buf, cap, pos, ",mv=");
    if (pos < 0) {
        return -1;
    }
    pos = append_u32(buf, cap, pos, mv);
    if (pos < 0) {
        return -1;
    }
    buf[pos] = '\0';
    return pos;
}

static const char *skip_space(const char *s)
{
    while (*s == ' ' || *s == '\t') {
        s++;
    }
    return s;
}

static int parse_u32(const char *s, const char *end, uint32_t *out)
{
    uint32_t value = 0;
    int digits = 0;

    s = skip_space(s);
    while (s < end && *s >= '0' && *s <= '9') {
        uint32_t next = value * 10u + (uint32_t)(*s - '0');
        if (next < value) {
            return -1;
        }
        value = next;
        digits++;
        s++;
    }
    s = skip_space(s);
    if (digits == 0 || s != end) {
        return -1;
    }
    *out = value;
    return 0;
}

static int key_is(const char *s, const char *end, const char *key)
{
    size_t n = strlen(key);
    return (size_t)(end - s) == n && memcmp(s, key, n) == 0;
}

int protocol_parse(const char *line, proto_msg_t *msg)
{
    char copy[PROTOCOL_LINE_MAX + 1];
    size_t len;
    char *cursor;
    int saw_cmd = 0;

    if (line == 0 || msg == 0) {
        return -1;
    }
    len = strlen(line);
    if (len == 0 || len > PROTOCOL_LINE_MAX) {
        return -1;
    }
    memcpy(copy, line, len + 1);
    memset(msg, 0, sizeof *msg);

    cursor = copy;
    while (cursor != 0 && *cursor != '\0') {
        char *comma = strchr(cursor, ',');
        char *eq;
        const char *key;
        const char *key_end;
        const char *val;
        const char *val_end;

        if (comma != 0) {
            *comma = '\0';
        }
        eq = strchr(cursor, '=');
        if (eq == 0) {
            return -1;
        }
        *eq = '\0';
        key = skip_space(cursor);
        key_end = key + strlen(key);
        while (key_end > key && (key_end[-1] == ' ' || key_end[-1] == '\t')) {
            key_end--;
        }
        val = skip_space(eq + 1);
        val_end = val + strlen(val);
        while (val_end > val && (val_end[-1] == ' ' || val_end[-1] == '\t')) {
            val_end--;
        }

        if (key_is(key, key_end, "cmd")) {
            saw_cmd = 1;
            if (key_is(val, val_end, "start")) {
                msg->kind = PROTO_KIND_CMD;
                msg->cmd = BOX_CMD_START;
            } else if (key_is(val, val_end, "stop")) {
                msg->kind = PROTO_KIND_CMD;
                msg->cmd = BOX_CMD_STOP;
            } else if (key_is(val, val_end, "reset")) {
                msg->kind = PROTO_KIND_CMD;
                msg->cmd = BOX_CMD_RESET;
            } else if (key_is(val, val_end, "interval")) {
                msg->kind = PROTO_KIND_CMD;
                msg->cmd = BOX_CMD_INTERVAL;
            } else if (key_is(val, val_end, "ack")) {
                msg->kind = PROTO_KIND_ACK;
            } else {
                return -1;
            }
        } else if (key_is(key, key_end, "interval") || key_is(key, key_end, "sec")) {
            if (parse_u32(val, val_end, &msg->interval_sec) != 0) {
                return -1;
            }
            msg->has_interval = 1;
        } else if (key_is(key, key_end, "seq")) {
            if (parse_u32(val, val_end, &msg->seq) != 0) {
                return -1;
            }
            msg->has_seq = 1;
        }
        cursor = comma == 0 ? 0 : comma + 1;
    }

    if (!saw_cmd) {
        return -1;
    }
    if (msg->kind == PROTO_KIND_ACK && !msg->has_seq) {
        return -1;
    }
    return 0;
}
