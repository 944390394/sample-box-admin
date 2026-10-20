#include "rtc_wake.h"

#include "civil_time.h"

#include "stm32l0xx.h"

#define RTC_MAGIC 0x0B00711Du

static volatile uint8_t rtc_flag;
static uint32_t chain_target;

static void rtc_unlock(void)
{
    RTC->WPR = 0xCAu;
    RTC->WPR = 0x53u;
}

static void rtc_lock(void)
{
    RTC->WPR = 0xFFu;
}

static int bcd_field(uint32_t reg, uint32_t units_pos, uint32_t tens_pos, uint32_t tens_mask)
{
    uint32_t units = (reg >> units_pos) & 0xFu;
    uint32_t tens = (reg >> tens_pos) & tens_mask;
    return (int)(tens * 10u + units);
}

static int rtc_enter_init(void)
{
    uint32_t spins = 1000000u;
    RTC->ISR |= RTC_ISR_INIT;
    while ((RTC->ISR & RTC_ISR_INITF) == 0u) {
        if (spins-- == 0u) {
            return -1;
        }
    }
    return 0;
}

int rtc_wake_init(void)
{
    EXTI->IMR |= EXTI_IMR_IM20;
    EXTI->RTSR |= EXTI_RTSR_TR20;
    NVIC_SetPriority(RTC_IRQn, 2);
    NVIC_EnableIRQ(RTC_IRQn);

    rtc_unlock();
    if (RTC->BKP0R == RTC_MAGIC && (RTC->ISR & RTC_ISR_INITS) != 0u) {
        rtc_lock();
        return 0;
    }
    if (rtc_enter_init() != 0) {
        rtc_lock();
        return -1;
    }
    RTC->PRER = 255u;
    RTC->PRER = (127u << 16) | 255u;
    RTC->TR = 0;
    /* 2000-01-01 是星期六，WDU=6。日历只给本地队列排序，平台时间以模组报文为准。 */
    RTC->DR = (6u << 13) | (1u << 8) | 1u;
    RTC->ISR &= ~RTC_ISR_INIT;
    RTC->BKP0R = RTC_MAGIC;
    rtc_lock();
    return 0;
}

uint32_t rtc_seconds(void)
{
    uint32_t tr;
    uint32_t dr;
    uint32_t spins = 2000000u;
    int year;
    int month;
    int day;
    int hour;
    int minute;
    int second;

    rtc_unlock();
    RTC->ISR &= ~RTC_ISR_RSF;
    while ((RTC->ISR & RTC_ISR_RSF) == 0u) {
        if (spins-- == 0u) {
            rtc_lock();
            return 0;
        }
    }
    tr = RTC->TR;
    dr = RTC->DR;
    rtc_lock();

    second = bcd_field(tr, RTC_TR_SU_Pos, RTC_TR_ST_Pos, 0x7u);
    minute = bcd_field(tr, RTC_TR_MNU_Pos, RTC_TR_MNT_Pos, 0x7u);
    hour = bcd_field(tr, RTC_TR_HU_Pos, RTC_TR_HT_Pos, 0x3u);
    day = bcd_field(dr, RTC_DR_DU_Pos, RTC_DR_DT_Pos, 0x3u);
    month = bcd_field(dr, RTC_DR_MU_Pos, RTC_DR_MT_Pos, 0x1u);
    year = 2000 + bcd_field(dr, RTC_DR_YU_Pos, RTC_DR_YT_Pos, 0xFu);
    return civil_to_seconds(year, month, day, hour, minute, second);
}

static int rtc_arm_seconds(uint32_t seconds)
{
    uint32_t spins = 1000000u;
    if (seconds == 0u) {
        seconds = 1u;
    }
    if (seconds > 65536u) {
        seconds = 65536u;
    }
    rtc_unlock();
    RTC->CR &= ~RTC_CR_WUTE;
    while ((RTC->ISR & RTC_ISR_WUTWF) == 0u) {
        if (spins-- == 0u) {
            rtc_lock();
            return -1;
        }
    }
    RTC->WUTR = seconds - 1u;
    RTC->CR = (RTC->CR & ~RTC_CR_WUCKSEL) | RTC_CR_WUCKSEL_2;
    RTC->ISR &= ~RTC_ISR_WUTF;
    EXTI->PR = EXTI_PR_PIF20;
    RTC->CR |= RTC_CR_WUTIE | RTC_CR_WUTE;
    rtc_lock();
    return 0;
}

void rtc_schedule(uint32_t target_sec)
{
    uint32_t now = rtc_seconds();
    uint32_t delta = target_sec > now ? target_sec - now : 1u;
    if (delta > 65535u) {
        chain_target = target_sec;
        delta = 65535u;
    } else {
        chain_target = 0;
    }
    rtc_arm_seconds(delta);
}

void rtc_disarm(void)
{
    chain_target = 0;
    rtc_unlock();
    RTC->CR &= ~(RTC_CR_WUTE | RTC_CR_WUTIE);
    rtc_lock();
}

int rtc_due(void)
{
    uint32_t now;
    if (rtc_flag == 0u) {
        return 0;
    }
    rtc_flag = 0;
    if (chain_target == 0u) {
        return 1;
    }
    now = rtc_seconds();
    if (now + 2u < chain_target) {
        rtc_schedule(chain_target);
        return 0;
    }
    chain_target = 0;
    return 1;
}

void RTC_IRQHandler(void)
{
    if ((RTC->ISR & RTC_ISR_WUTF) != 0u) {
        RTC->ISR &= ~RTC_ISR_WUTF;
        rtc_flag = 1;
    }
    EXTI->PR = EXTI_PR_PIF20;
}
