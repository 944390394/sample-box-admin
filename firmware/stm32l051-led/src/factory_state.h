#ifndef FACTORY_STATE_H
#define FACTORY_STATE_H
#include <stdint.h>

typedef enum { FACTORY_IDLE, FACTORY_DEBOUNCE, FACTORY_HOLD, FACTORY_RUN, FACTORY_ERROR } factory_phase_t;
typedef struct {
    factory_phase_t phase;
    uint32_t elapsed;
    uint8_t armed;
} factory_state_t;

/* 每毫秒调用；pressed 为 PB5 的低有效值。启动必须先释放，避免复位后反复清除。 */
void factory_state_init(factory_state_t *state);
void factory_state_tick(factory_state_t *state, int pressed);
/* -1 恢复正常指示；其余值为 PB12/PB13/PB14 对应的点亮位。 */
int factory_state_lights(const factory_state_t *state);
#endif
