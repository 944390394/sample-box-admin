#include "civil_time.h"

static int is_leap(int year)
{
    if (year % 400 == 0) {
        return 1;
    }
    if (year % 100 == 0) {
        return 0;
    }
    return year % 4 == 0;
}

uint32_t civil_to_seconds(int year, int month, int day, int hour, int minute, int second)
{
    static const int mdays[12] = {31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31};
    int days = 0;
    int y;
    int m;

    if (year < 2000) {
        year = 2000;
    }
    if (month < 1) {
        month = 1;
    }
    if (month > 12) {
        month = 12;
    }
    if (day < 1) {
        day = 1;
    }

    for (y = 2000; y < year; y++) {
        days += is_leap(y) ? 366 : 365;
    }
    for (m = 1; m < month; m++) {
        days += mdays[m - 1];
        if (m == 2 && is_leap(year)) {
            days += 1;
        }
    }
    days += day - 1;
    return (uint32_t)days * 86400u + (uint32_t)hour * 3600u + (uint32_t)minute * 60u + (uint32_t)second;
}
