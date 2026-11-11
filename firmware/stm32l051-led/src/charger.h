#ifndef CHARGER_H
#define CHARGER_H

#include <stdint.h>

#include "event.h"

/*
 * TP4057。CHRG# 低电平表示正在充电，STDBY# 低电平表示充满。
 * 两脚都为高表示没插充电器。状态稳定 50 ms 后才算数。
 * 只有插上、拔掉（没插 ↔ 插着）才立即上报。插着时「充电中」和「已充满」会来回跳：
 * 模块发数据时电池电压被拉低，芯片又开始充，充一下又满，每跳一次都报的话会刷屏、还多耗电。
 * 这种跳动只更新状态，下一条定时上报带上。
 */
typedef struct {
    event_queue_t *queue;
    uint8_t stable;
    uint8_t pending;
    uint8_t pending_ms;
    /* 充满锁定：芯片报过充满后置 1，记下当时的电压 full_mv。见 charger_view。 */
    uint8_t held;
    int full_mv;
} charger_t;

/*
 * 充满以后，电池电压要比充满时低这么多，才重新算「充电中」。
 * TP4057 充满后电池只要被用掉一点（模块发数据时一拉）就会再充几秒、又报充满，
 * 引脚在 CHRG/STDBY 之间来回跳；对外（上报、指示灯、电池学习）一律按「已充满」，
 * 直到拔掉充电器或电压真的掉了 0.15 V。
 */
#define CHARGE_FULL_HOLD_MV 150

void charger_init(charger_t *charger, event_queue_t *queue);
void charger_on_ms(charger_t *charger);
/* 引脚原样：0 没插、1 充电中、2 已充满。中断里也能调。 */
int charger_status(void);
/*
 * 对外的充电状态（0/1/2），带充满锁定。只在主循环里调：battery_mv 是最近一次安静时测的电压，
 * 没测到时传 0，锁定不会因此解除。
 */
int charger_view(charger_t *charger, int battery_mv);
/* 引脚和已确认的状态一致，没有正在去抖的变化：可以进 Stop。 */
int charger_settled(const charger_t *charger);

#endif
