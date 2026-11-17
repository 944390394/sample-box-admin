/* 主机验证充满锁定（0.15 V 缓冲）和充电灯的三种节拍；只替换 GPIO。 */
#include <assert.h>
#include <string.h>
#include "board.h"
#include "charger.h"
#include "clock.h"
#include "event.h"
#include "gpio.h"
#include "battery.h"
#include "led.h"

static int pins[16];
void gpio_write(uint32_t port, uint32_t pin, int high) { (void)port; pins[pin] = !!high; }
int gpio_read(uint32_t port, uint32_t pin) { (void)port; return pins[pin]; }
void gpio_set_output(uint32_t port, uint32_t pin) { (void)port; (void)pin; }
void gpio_set_analog(uint32_t port, uint32_t pin) { (void)port; (void)pin; }
void gpio_set_input(uint32_t port, uint32_t pin, gpio_pull_t pull) { (void)port; (void)pin; (void)pull; }
void factory_reset_on_ms(void) {}
void lid_on_ms(lid_t *lid) { (void)lid; }
void SysTick_Handler(void);
static void tick(unsigned n) { while (n--) SysTick_Handler(); }

static void test_hold(void)
{
    charger_t c;
    event_queue_t q;
    event_init(&q);
    pins[BOARD_PIN_CHRG] = 1;
    pins[BOARD_PIN_STDBY] = 1;
    charger_init(&c, &q);
    assert(charger_view(&c, 3900) == 0);
    /* 插上在充 */
    c.stable = 1;
    assert(charger_view(&c, 3950) == 1);
    /* 充满：锁定，记下 4180 */
    c.stable = 2;
    assert(charger_view(&c, 4180) == 2 && c.held && c.full_mv == 4180);
    /* 模块发数据一拉，芯片又充几秒：电压只掉一点，仍算已充满 */
    c.stable = 1;
    assert(charger_view(&c, 4150) == 2);
    assert(charger_view(&c, 4040) == 2); /* 掉 140 mV，还在缓冲里 */
    c.stable = 2;
    assert(charger_view(&c, 4190) == 2 && c.full_mv == 4190); /* 更高的充满电压跟着抬 */
    /* 没测到电压不解除 */
    c.stable = 1;
    assert(charger_view(&c, 0) == 2);
    /* 还没锁定时，没有电压不能把「充满」记下来 */
    c.held = 0;
    c.full_mv = 0;
    c.stable = 2;
    assert(charger_view(&c, 0) == 2 && !c.held && c.full_mv == 0);
    /* 真掉了 0.15 V：重新算充电中 */
    c.held = 1;
    c.full_mv = 4190;
    c.stable = 1;
    assert(charger_view(&c, 4040) == 1 && !c.held);
    assert(charger_view(&c, 4100) == 1);
    /* 拔掉：解除，下次插上重新判断 */
    c.stable = 2;
    assert(charger_view(&c, 4200) == 2 && c.held);
    c.stable = 0;
    assert(charger_view(&c, 4100) == 0 && !c.held);
    c.stable = 1;
    assert(charger_view(&c, 4100) == 1);
}

static void test_chatter(void)
{
    charger_t c;
    event_queue_t q;
    unsigned i;
    event_init(&q);
    pins[BOARD_PIN_CHRG] = 1;
    pins[BOARD_PIN_STDBY] = 0;
    charger_init(&c, &q);
    assert(charger_shown(&c) == 0);
    for (i = 0; i < 2000u; i++) {
        pins[BOARD_PIN_CHRG] = (i / 100u) % 2u == 0u;
        pins[BOARD_PIN_STDBY] = !pins[BOARD_PIN_CHRG];
        charger_on_ms(&c);
    }
    assert(charger_shown(&c) == 0);
    pins[BOARD_PIN_CHRG] = 0;
    pins[BOARD_PIN_STDBY] = 1;
    charger_init(&c, &q);
    for (i = 0; i < CHARGE_SHOW_MS - 1u; i++) charger_on_ms(&c);
    assert(charger_shown(&c) == 0);
    charger_on_ms(&c);
    assert(charger_shown(&c) == 1);
}

static void test_battery_present(void)
{
    /* 没接电池：VDDA 只有 2.65 V，分压脚却读出 3.65 V，不能当成电池在。 */
    assert(!battery_reading_ok(3651, 2650));
    assert(battery_consider(3651, 2650) == 0);
    assert(battery_consider(3640, 2650) == 0);
    assert(!battery_present());
    /* 供电正常时，一次落在电池范围内就认定接上。充电中掉零点几伏也还在。 */
    assert(battery_reading_ok(4057, 3312));
    assert(battery_consider(4057, 3312) == 1);
    assert(battery_present());
    assert(battery_consider(3700, 3312) == 1);
    assert(!battery_reading_ok(2000, 3300));
    assert(battery_consider(2000, 3300) == 0);
    assert(!battery_present());
}

static void test_light(void)
{
    led_t led;
    unsigned i, on;
    clock_start(0, 0, 0, 60000);
    led_init(&led);
    /* 没插：灭（共阳，引脚高为灭） */
    led_show(&led, 0, LED_CHARGE_NONE, 0);
    assert(pins[BOARD_PIN_LED_CHG] == 1);
    /* 已充满：常亮 */
    for (i = 0; i < 3000; i += 100) {
        tick(100);
        led_show(&led, 0, LED_CHARGE_FULL, 0);
        assert(pins[BOARD_PIN_LED_CHG] == 0);
    }
    /* 充电中：亮 1 秒灭 1 秒，4 秒里亮一半 */
    on = 0;
    for (i = 0; i < 4000; i += 50) {
        tick(50);
        led_show(&led, 0, LED_CHARGE_ON, 0);
        on += pins[BOARD_PIN_LED_CHG] == 0;
    }
    assert(on == 40);
    /* 电量低：快闪，0.25 秒一换，1 秒里换 4 次 */
    {
        unsigned changes = 0;
        int last;
        led_show(&led, 0, LED_CHARGE_LOW, 0);
        last = pins[BOARD_PIN_LED_CHG];
        for (i = 0; i < 1000; i += 10) {
            tick(10);
            led_show(&led, 0, LED_CHARGE_LOW, 0);
            if (pins[BOARD_PIN_LED_CHG] != last) {
                changes++;
                last = pins[BOARD_PIN_LED_CHG];
            }
        }
        assert(changes == 4);
    }
    /* 服务器关灯：用电池时全灭；插着充电器时充电那一路照样亮，箱盖、联网两路仍灭 */
    clock_set_lights(0);
    led_show(&led, 1, LED_CHARGE_NONE, 1);
    assert(pins[BOARD_PIN_LED_CHG] == 1 && pins[BOARD_PIN_LED_LID] == 1 && pins[BOARD_PIN_LED_RDY] == 1);
    led_show(&led, 1, LED_CHARGE_FULL, 1);
    assert(pins[BOARD_PIN_LED_CHG] == 0 && pins[BOARD_PIN_LED_LID] == 1 && pins[BOARD_PIN_LED_RDY] == 1);
    clock_set_lights(1);
    /* 日常不点就绪灯，箱盖灯仍跟随。 */
    led_show(&led, 1, LED_CHARGE_NONE, 1);
    assert(pins[BOARD_PIN_LED_LID] == 0 && pins[BOARD_PIN_LED_RDY] == 1);
}

int main(void)
{
    memset(pins, 0, sizeof pins);
    test_hold();
    test_chatter();
    test_battery_present();
    test_light();
    return 0;
}
