#include "battery.h"

int battery_percent(uint16_t mv)
{
    if (mv <= BATTERY_MV_EMPTY) {
        return 0;
    }
    if (mv >= BATTERY_MV_FULL) {
        return 100;
    }
    return (int)(((uint32_t)mv - BATTERY_MV_EMPTY) * 100u / (BATTERY_MV_FULL - BATTERY_MV_EMPTY));
}

int battery_led_mask(int percent)
{
    if (percent >= 75) {
        return 0x0F;
    }
    if (percent >= 50) {
        return 0x07;
    }
    if (percent >= 25) {
        return 0x03;
    }
    if (percent >= 5) {
        return 0x01;
    }
    return 0x01 | 0x80;
}
