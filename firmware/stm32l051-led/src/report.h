#ifndef REPORT_H
#define REPORT_H

#include <stdint.h>

/* 一行报文：why,opens,lid,openage,chg,bat,t,poff,seq。没对时不带 t，没有掉电记录不带 poff。 */
typedef struct {
    uint32_t seq;
} report_t;

void report_init(report_t *report);
int report_compose(report_t *report, const char *why, uint32_t opens, int lid_open, int has_open_age,
                   uint32_t open_age_s, int charge, int battery_mv, int has_time, uint64_t time_ms,
                   int has_poff, uint64_t poff_ms, int has_free, uint32_t free_bytes, int has_learn,
                   int learn_hi, int learn_lo, int learn_n, char *dst, unsigned cap);

#endif
