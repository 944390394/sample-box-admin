#include "board.h"
#include "clock.h"
#include "gpio.h"
#include "led.h"

static void cathode(led_t *led, uint32_t pin, int on)
{
    gpio_write(led->port, pin, on ? 0 : 1);
}

void led_init(led_t *led)
{
    led->port = BOARD_PORT_B;
    led->override = -1;
    led->normal = 0;
    led->keep = 0;
    led->lid_pin = BOARD_PIN_LED_LID;
    led->charge_pin = BOARD_PIN_LED_CHG;
    led->ready_pin = BOARD_PIN_LED_RDY;
    gpio_write(led->port, led->lid_pin, 1);
    gpio_write(led->port, led->charge_pin, 1);
    gpio_write(led->port, led->ready_pin, 1);
    gpio_set_output(led->port, led->lid_pin);
    gpio_set_output(led->port, led->charge_pin);
    gpio_set_output(led->port, led->ready_pin);
}

/** 充电那一路此刻该不该亮，节拍取自 clock_ms。见 led.h 的 LED_CHARGE_*。 */
static int charge_lit(int charge)
{
    uint32_t ms = clock_ms();
    if (charge == LED_CHARGE_FULL) {
        return 1;
    }
    if (charge == LED_CHARGE_LOW) {
        return ((ms / 250u) & 1u) == 0u;
    }
    if (charge == LED_CHARGE_ON) {
        return ((ms / 1000u) & 1u) == 0u;
    }
    return 0;
}

void led_show(led_t *led, int lid_open, int charge, int ready)
{
    int charge_on = charge_lit(charge);
    #ifndef HOST_TEST
    uint32_t saved;
    __asm volatile("mrs %0, primask\n cpsid i" : "=r"(saved) :: "memory");
    #endif
    led->normal = (lid_open ? 1u : 0u) | (charge_on ? 2u : 0u) | (ready ? 4u : 0u);
    led->keep = charge != LED_CHARGE_NONE ? 2u : 0u;
    led_override(led, led->override);
    #ifndef HOST_TEST
    __asm volatile("msr primask, %0" :: "r"(saved) : "memory");
    #endif
}

void led_override(led_t *led, int mask)
{
    led->override = mask;
    /*
     * 日常灯全灭时引脚保持高电平（共阳，不浮空）；恢复出厂等进度灯走 override，不受影响。
     * 关灯时插着充电器，充电那一路照样亮（keep），不缺电。
     */
    if (mask < 0) mask = clock_lights_on() ? led->normal : (led->normal & led->keep);
    cathode(led, led->lid_pin, mask & 1);
    cathode(led, led->charge_pin, mask & 2);
    cathode(led, led->ready_pin, mask & 4);
}
