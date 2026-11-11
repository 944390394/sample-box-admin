#ifndef LED_H
#define LED_H

/* LED1 共阳，阴极低电平点亮。PB12 跟随箱盖，PB13 跟随充电，PB14 跟随 RDY。 */
typedef struct {
    uint32_t port;
    uint32_t lid_pin;
    uint32_t charge_pin;
    uint32_t ready_pin;
    int override;
    uint8_t normal;
    /* 插着充电器时为 2：服务器关了灯（省电池用），充电那一路照样亮 */
    uint8_t keep;
} led_t;

/*
 * 充电那一路颜色怎么亮（led_show 的 charge 参数）：
 *   LED_CHARGE_NONE  没插充电器：灭
 *   LED_CHARGE_ON    充电中：慢闪，亮 1 秒、灭 1 秒
 *   LED_CHARGE_LOW   充电中、电池电压低于 LED_CHARGE_LOW_MV：快闪，亮 0.25 秒、灭 0.25 秒
 *   LED_CHARGE_FULL  已充满（带 0.15 V 锁定，见 charger.h）：常亮
 * 插着充电器时单片机不进 Stop（main.c 的 can_stop），主循环一直在转，闪烁节拍准；用电池时不闪，不费电。
 * 服务器关灯（上报里 rl=0）是为了省电池：插着充电器时不缺电，充电那一路不受它管，照样按上面亮；
 * 箱盖、联网两路仍按服务器设置。
 */
#define LED_CHARGE_NONE 0
#define LED_CHARGE_ON 1
#define LED_CHARGE_FULL 2
#define LED_CHARGE_LOW 3
#define LED_CHARGE_LOW_MV 3500

void led_init(led_t *led);
void led_show(led_t *led, int lid_open, int charge, int ready);
void led_override(led_t *led, int mask);

#endif
